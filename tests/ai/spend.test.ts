import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_SPEND_CAP_USD, DEFAULT_GLOBAL_SPEND_CAP_USD, DEFAULT_INTERACTIVE_RESERVE_USD,
  DEFAULT_OPENROUTER_ATTEMPT_CEILING_USD, backgroundSpendCapUsd, globalSpendCapUsd, interactiveReserveUsd,
  openRouterAttemptCeilingUsd, openRouterAttemptCost, reserveSpend, settleSpend,
} from "@/lib/ai/spend";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const adminWith = (rpc: Rpc) => ({ rpc: vi.fn(rpc) });

describe("reserveSpend (scale S2: atomic reservation, fail closed)", () => {
  it("reserves the estimate against the user cap and the global ceiling from the env", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    vi.stubEnv("AI_GLOBAL_DAILY_SPEND_CAP_USD", "12");
    const admin = adminWith(async () => ({ data: [{ reservation_id: "r1", allowed: true,
      reason: null, user_committed_usd: 0.1, global_committed_usd: 1 }], error: null }));
    await expect(reserveSpend(admin as never, "user-a", 0.05))
      .resolves.toEqual({ id: "r1", amountUsd: 0.05 });
    expect(admin.rpc).toHaveBeenCalledWith("ai_spend_reserve_split", { p_user_id: "user-a",
      p_amount_usd: 0.05, p_user_cap_usd: 0.5, p_global_cap_usd: 12, p_ttl_seconds: 300,
      p_background: false, p_background_cap_usd: 10, p_interactive_reserve_usd: 1 });
  });

  it("marks a background call and sends the OD01 splits from the env", async () => {
    vi.stubEnv("AI_BACKGROUND_DAILY_SPEND_CAP_USD", "4");
    vi.stubEnv("AI_INTERACTIVE_RESERVE_USD", "1.5");
    const admin = adminWith(async () => ({ data: [{ reservation_id: "r2", allowed: true,
      reason: null, user_committed_usd: 0.1, global_committed_usd: 1 }], error: null }));
    await reserveSpend(admin as never, "user-a", 0.05, { background: true });
    expect(admin.rpc).toHaveBeenCalledWith("ai_spend_reserve_split", expect.objectContaining({
      p_background: true, p_background_cap_usd: 4, p_interactive_reserve_usd: 1.5 }));
  });

  it("defaults the background ceiling to $10 and the interactive reserve to $1 (OD01)", () => {
    expect(backgroundSpendCapUsd()).toBe(DEFAULT_BACKGROUND_SPEND_CAP_USD);
    expect(DEFAULT_BACKGROUND_SPEND_CAP_USD).toBe(10);
    expect(interactiveReserveUsd()).toBe(DEFAULT_INTERACTIVE_RESERVE_USD);
    expect(DEFAULT_INTERACTIVE_RESERVE_USD).toBe(1);
  });

  it.each(["background_cap", "background_user_cap"])("refuses a background call with spend_cap on %s", async (reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const admin = adminWith(async () => ({ data: [{ reservation_id: null, allowed: false,
      reason, user_committed_usd: 1, global_committed_usd: 10 }], error: null }));
    await expect(reserveSpend(admin as never, "user-a", 0.05, { background: true }))
      .rejects.toMatchObject({ status: 429, code: "spend_cap" });
  });

  it("defaults the global ceiling to $50 and refuses a malformed env value", async () => {
    expect(globalSpendCapUsd()).toBe(DEFAULT_GLOBAL_SPEND_CAP_USD);
    expect(DEFAULT_GLOBAL_SPEND_CAP_USD).toBe(50);
    vi.stubEnv("AI_GLOBAL_DAILY_SPEND_CAP_USD", "lots");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(globalSpendCapUsd()).toBe(50);
  });

  it("keeps the cap-reached copy when the user cap refuses", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "2");
    const admin = adminWith(async () => ({ data: [{ reservation_id: null, allowed: false,
      reason: "user_cap", user_committed_usd: 1.99, global_committed_usd: 3 }], error: null }));
    await expect(reserveSpend(admin as never, "user-a", 0.05)).rejects.toMatchObject({
      status: 429, code: "spend_cap", message: "daily AI spend cap reached: $1.99 of $2.00" });
  });

  it("answers the same spend_cap code when the global ceiling refuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = adminWith(async () => ({ data: [{ reservation_id: null, allowed: false,
      reason: "global_cap", user_committed_usd: 0, global_committed_usd: 50 }], error: null }));
    await expect(reserveSpend(admin as never, "user-a", 0.05))
      .rejects.toMatchObject({ status: 429, code: "spend_cap" });
  });

  it.each([
    ["an error", async () => ({ data: null, error: { message: "down" } })],
    ["a throw", async () => { throw new Error("socket"); }],
    ["a malformed row", async () => ({ data: [{ nope: 1 }], error: null })],
    ["an allow with no id", async () => ({ data: [{ allowed: true }], error: null })],
  ] as [string, Rpc][])("refuses with 503 on %s (fail closed)", async (_label, rpc) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(reserveSpend(adminWith(rpc) as never, "user-a", 0.05))
      .rejects.toMatchObject({ status: 503, code: "spend_unavailable" });
  });
});

describe("the OpenRouter allowance", () => {
  it("must be a number above zero; anything else falls back to the default, logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("AI_OPENROUTER_ATTEMPT_CEILING_USD", "0.4");
    expect(openRouterAttemptCeilingUsd()).toBe(0.4);
    for (const bad of ["0", "-1", "lots"]) {
      vi.stubEnv("AI_OPENROUTER_ATTEMPT_CEILING_USD", bad);
      expect(openRouterAttemptCeilingUsd()).toBe(DEFAULT_OPENROUTER_ATTEMPT_CEILING_USD);
    }
    expect(log).toHaveBeenCalled();
  });

  it("logs an attempt that cost more than the allowance and still records it in full", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("AI_OPENROUTER_ATTEMPT_CEILING_USD", "0.1");
    expect(openRouterAttemptCost(0.05)).toBe(0.05);
    expect(warn).not.toHaveBeenCalled();
    expect(openRouterAttemptCost(0.3)).toBe(0.3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("allowance"), expect.anything());
  });
});

describe("settleSpend", () => {
  it("records an actual cost over the hold in full and warns (the bounded overshoot)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const admin = adminWith(async () => ({ data: true, error: null }));
    await settleSpend(admin as never, { id: "r1", amountUsd: 0.1 }, 0.3, { sweepChance: 0 });
    expect(admin.rpc).toHaveBeenCalledWith("ai_spend_settle", { p_reservation_id: "r1", p_actual_usd: 0.3 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bounded overshoot"), expect.anything());
  });

  it("runs the bounded sweep in its own call after the settle", async () => {
    const admin = adminWith(async () => ({ data: true, error: null }));
    await settleSpend(admin as never, { id: "r1", amountUsd: 0.1 }, 0.01, { sweepChance: 1 });
    expect(admin.rpc.mock.calls.map(([fn]) => fn)).toEqual(["ai_spend_settle", "ai_spend_sweep"]);
  });

  it("settles the actual cost once", async () => {
    const admin = adminWith(async () => ({ data: true, error: null }));
    await settleSpend(admin as never, { id: "r1", amountUsd: 0.1 }, 0.004, { sweepChance: 0 });
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledWith("ai_spend_settle",
      { p_reservation_id: "r1", p_actual_usd: 0.004 });
  });

  it("retries once, then logs and never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = adminWith(async () => ({ data: null, error: { message: "down" } }));
    await expect(settleSpend(admin as never, { id: "r1", amountUsd: 0.1 }, 0.01, { sweepChance: 0 }))
      .resolves.toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
  });
});

describe("SystemOne production call sites", () => {
  it("passes userId at every systemOne call under lib and app", () => {
    const calls = ["lib", "app"].flatMap((root) => collectSystemOneCalls(root));

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !call.hasUserId)).toEqual([]);
  });
});

type CallSite = { file: string; line: number; hasUserId: boolean };

function collectSystemOneCalls(root: string): CallSite[] {
  return sourceFiles(root).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const calls: CallSite[] = [];

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && isSystemOne(node.expression)) {
        // Phase 13 §9 R3: systemOne(payload, options) — the options are the second argument.
        const options = node.arguments[1];
        const hasUserId = ts.isObjectLiteralExpression(options)
          && options.properties.some((property) => property.name?.getText(sourceFile) === "userId");
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        calls.push({ file: path.relative(process.cwd(), file), line, hasUserId });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return calls;
  });
}

function isSystemOne(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === "systemOne"
    || ts.isPropertyAccessExpression(expression) && expression.name.text === "systemOne";
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("OD01 background purposes", () => {
  it("are all registered purposes", async () => {
    const { BACKGROUND_PURPOSES, CALL_REGISTRY } = await import("@/lib/ai/call-registry");
    for (const purpose of BACKGROUND_PURPOSES) expect(Object.keys(CALL_REGISTRY)).toContain(purpose);
    expect([...BACKGROUND_PURPOSES].sort()).toEqual(["food_facets", "weeklyReview"]);
  });
});
