/**
 * T4 — coach and weekly review route per the data-handling record (spec B-04): Gemini is the
 * only provider, and health context needs the project attestation.
 *
 * Two layers, both required by the audit:
 *   1. the pure health-context gate (lib/ai/attestation.ts);
 *   2. the real adapter, driven end-to-end — `runTurn` / `writeWeeklyReview` call the real
 *      `generateStructured` with the REAL schemas (`turnStepWireSchema` in, the discriminated
 *      union out) and `GenerateDeps` stubs, so the test proves which provider the adapter
 *      actually reached, with which lowered `responseSchema`, not what arguments a spy was
 *      handed. Substituting the schema hid the `oneOf` rejection that made the coach 503.
 *
 * The canary guard executes the import-safe canary (injected probe, no network) and proves the
 * retention record is byte-identical by hash before/after, backed by a check that the module has
 * no filesystem import at all — it does not merely grep the source.
 */
import { withSpendRpc } from "@/tests/ai/spend-admin";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateStructured, MODELS, recentFailureCount,
  type GenerateDeps, type ProviderResult }
  from "@/lib/ai/adapter";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { GEMINI_COACH, GEMINI_FLASH } from "@/lib/ai/models";
import { writeWeeklyReview } from "@/lib/server/coach";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { healthContextRefused } from "@/lib/ai/attestation";
import { turnStepWireSchema } from "@/lib/coach/turn";
import { canary } from "@/scripts/ai-canary";

const REQ = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000010", text: "" };

/** The `responseSchema` the adapter lowered and handed to the provider stub, for the Nth call. */
const loweredSchema = (
  mock: { mock: { calls: unknown[][] } }, at = 0
): Record<string, unknown> => mock.mock.calls[at][2] as Record<string, unknown>;

/**
 * One Supabase double for both the coach path and the real adapter: reads resolve from `tables`,
 * inserts land in `writes` and are read back (the adapter writes ai_calls, the coach reads it
 * for ai_call_id). Chains are thenable, like PostgREST's.
 */
function db(tables: Record<string, Record<string, unknown>[]> = {}) {
  const writes: { table: string; row: Record<string, unknown> }[] = [];
  const store: Record<string, Record<string, unknown>[]> = {
    ai_calls: [], coach_threads: [], coach_messages: [], gut_log: [], ...tables,
  };
  const from = (table: string) => {
    let pending: Record<string, unknown> | null = null;
    // `ai_calls` is filtered for real (eq/in/gte), the same three circuit.ts
    // (lib/ai/circuit.ts recentFailureCount) reads, so a query SCOPED to one status or model
    // reads only matching rows — every other table stays lenient (unfiltered) as it always was,
    // since nothing here reads it through a status/model/time window.
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, readonly unknown[]][] = [];
    const gteFilters: [string, unknown][] = [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (col: string, val: unknown) => { eqFilters.push([col, val]); return chain; },
      neq: () => chain,
      in: (col: string, vals: readonly unknown[]) => { inFilters.push([col, vals]); return chain; },
      is: () => chain,
      gte: (col: string, val: unknown) => { gteFilters.push([col, val]); return chain; },
      order: () => chain, limit: () => chain,
      insert: (row: Record<string, unknown>) => {
        // Real `ai_calls` rows get `created_at` from the database default; the circuit's own
        // `gte("created_at", ...)` window read needs one here too.
        const stored = table === "ai_calls" && row.created_at === undefined
          ? { ...row, created_at: new Date().toISOString() } : row;
        pending = row;
        writes.push({ table, row });
        store[table] = [...(store[table] ?? []), stored];
        return chain;
      },
      update: (row: Record<string, unknown>) => { writes.push({ table, row }); return chain; },
      maybeSingle: async () =>
        ({ data: pending ?? (store[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: pending ?? (store[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
        const rows = table !== "ai_calls" ? (store[table] ?? []) : (store[table] ?? []).filter((row) =>
          eqFilters.every(([col, val]) => row[col] === val)
          && inFilters.every(([col, vals]) => vals.includes(row[col]))
          && gteFilters.every(([col, val]) => (row[col] as string) >= (val as string)));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    });
    return chain;
  };
  return { client: withSpendRpc({ from, rpc: async () => ({ data: [], error: null }) }) as never, writes };
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-11", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => null,
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [],
  getConstraints: async () => ({ avoid_allergens: ["gluten", "dairy", "apple"] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

const HEALTHY = { constraint_profiles: [{ rev: 1, conditions: ["ulcerative colitis"],
  notes: null, avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
  banned_categories: [], custom_rules: [] }] };

/** A stub provider result the turn schema would accept. */
const finalStep = async (): Promise<ProviderResult> => ({
  text: JSON.stringify({ kind: "final", text: "eat rice", suggestions: [] }),
  inputTokens: 30, outputTokens: 15,
});

/** The deps hook the adapter exposes: the Gemini transport is stubbed, so the test sees exactly
 *  what the adapter sent to the one provider it calls. */
function providerStubs() {
  const callGemini = vi.fn(finalStep);
  return { deps: { sleep: async () => {}, callGemini } as GenerateDeps, callGemini };
}

const okRows = (writes: { table: string; row: Record<string, unknown> }[]) =>
  writes.filter((w) => w.table === "ai_calls" && w.row.status === "ok");

/** Every `ai_calls` row the adapter wrote, whatever its status. */
const aiCallRows = (writes: { table: string; row: Record<string, unknown> }[]) =>
  writes.filter((w) => w.table === "ai_calls");

/** Wire-valid and lowerable, but no union member: a "final" with no text. */
const notAStep = async (): Promise<ProviderResult> => ({
  text: JSON.stringify({ kind: "final" }), inputTokens: 30, outputTokens: 15,
});

describe("healthContextRefused (the pure health-context gate)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const health = { conditions: ["ulcerative colitis"], notes: null };
  const none = { conditions: [], notes: null };

  it("never refuses a profile with no conditions or notes", () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    expect(healthContextRefused(none)).toBe(false);
  });

  it("refuses health context while the policy switch is unset", () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    expect(healthContextRefused(health)).toBe(true);
    expect(healthContextRefused({ conditions: [], notes: "low sodium" })).toBe(true);
  });

  it("keeps refusing when the switch is set but billing is not attested", () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    expect(healthContextRefused(health)).toBe(true);
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "true");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    expect(healthContextRefused(health)).toBe(true);
  });

  it("lets health context through only with the switch and the attestation", () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    expect(healthContextRefused(health)).toBe(false);
  });
});

/**
 * These cases are about PROVIDER routing, so the classifier is stubbed out: a
 * live classify call would reach the network and, with no target revision on
 * these fixtures, take the `needs_profile` fast path before `generate` runs.
 */
const noClassify = () => vi.fn().mockResolvedValue(null) as never;

describe("runTurn through the real adapter", () => {
  beforeEach(() => { vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("routes a non-health turn to the Gemini stub on the coach pin", async () => {
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    const res = await runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" });

    expect(callGemini).toHaveBeenCalledTimes(1);
    expect((callGemini.mock.calls[0] as unknown[])[0]).toBe(GEMINI_COACH);
    // The real lowering, on the real PROVIDER schema: one flat object, no `oneOf` to refuse, and
    // every key required — which is what makes constrained decoding emit `actions` at all
    // (lib/coach/turn.ts).
    expect(loweredSchema(callGemini)).toMatchObject({
      type: "object",
      required: ["kind", "calls", "actions", "suggestions", "text", "memory", "reason"],
      properties: { kind: { type: "string", enum: ["tool", "final", "abort"] } },
    });
    expect(Object.keys(loweredSchema(callGemini).properties as object))
      // `actions` and `suggestions` sit BEFORE `text` on purpose — lib/coach/turn.ts says why.
      .toEqual(["kind", "calls", "actions", "suggestions", "text", "memory", "reason"]);
    expect(JSON.stringify(loweredSchema(callGemini))).not.toMatch(/oneOf|anyOf|\$ref/);
    expect(okRows(writes)).toHaveLength(1);
    expect(okRows(writes)[0].row).toMatchObject({ provider: "google", model_id: GEMINI_COACH });
    expect(res.model).toEqual({ provider: "gemini", modelId: GEMINI_COACH });
  });

  it("maps a flat tool step back to the union and runs it, then answers on the next round", async () => {
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    callGemini
      .mockResolvedValueOnce({
        text: JSON.stringify({ kind: "tool", calls: [{ name: "get_day", args: { date: "2026-09-11" } }] }),
        inputTokens: 30, outputTokens: 15,
      })
      .mockResolvedValueOnce(await finalStep());
    const res = await runTurn(client, client, "u1", { ...REQ, text: "how did Monday go" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" });

    expect(callGemini).toHaveBeenCalledTimes(2);
    expect(res.toolsUsed).toEqual(["get_day"]);
    expect(okRows(writes)).toHaveLength(2);
    expect(okRows(writes)[0].row).toMatchObject({ provider: "google", model_id: GEMINI_COACH });
  });

  it("refuses a health-context turn with 503, reaching neither provider", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");   // the health switch is off
    const { client, writes } = db(HEALTHY);
    const { deps, callGemini } = providerStubs();
    await expect(runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(okRows(writes)).toHaveLength(0);
  });

  it("keeps refusing a health-context turn when the switch is on but the attestation is missing", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const { client } = db(HEALTHY);
    const { deps, callGemini } = providerStubs();
    await expect(runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("lets a health-context turn reach the Gemini stub once the switch is on and attested", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "1");
    const { client, writes } = db(HEALTHY);
    const { deps, callGemini } = providerStubs();
    const res = await runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" });
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(okRows(writes)[0].row).toMatchObject({ provider: "google", model_id: GEMINI_COACH });
    expect(res.model).toEqual({ provider: "gemini", modelId: GEMINI_COACH });
  });

  it("refuses a non-health turn's text with 503 when the attestation is off (spec §9 R3)", async () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    await expect(runTurn(client, client, "u1", { ...REQ, text: "I have colitis, what can I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(aiCallRows(writes)).toHaveLength(0);
  });

  it("refuses the weekly review when the attestation is off", async () => {
    vi.stubEnv("HEALTH_CONTEXT_PROVIDER", "");
    const { client } = db();
    const { deps, callGemini } = providerStubs();
    await expect(writeWeeklyReview(client, "u1", "2026-09-07",
      { generate: (args) => generateStructured(args, deps), latestEstimate: async () => null }))
      .rejects.toMatchObject({ status: 503, code: "nous_unconfirmed" });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("answers 503 coach_unavailable, not a schema crash, when the reply cannot be a step", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    callGemini.mockImplementation(notAStep);
    await expect(runTurn(client, client, "u1", { ...REQ, text: "what should I eat" },
      { generate: (args) => generateStructured(args, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    // The union is inside the schema the adapter validates with, so the adapter's own
    // SchemaRejection fires on each attempt: three calls, then the runTurn 503. There is no
    // fallback, because a schema refusal is OURS and a second model refuses it the same way
    // (Grok pass 1, MEDIUM 17). The row is schema_invalid, not ok.
    expect(callGemini).toHaveBeenCalledTimes(3);
    expect(okRows(writes)).toHaveLength(0);
    expect(aiCallRows(writes)).toHaveLength(1);
    expect(aiCallRows(writes)[0].row).toMatchObject({ status: "schema_invalid" });
    expect(logged).toHaveBeenCalledWith("coach generation failed", {
      provider: "google",
      modelId: GEMINI_COACH,
      error: { name: "Error", message: expect.stringContaining("schema") },
    });
    // A reply the schema rejected came from a provider that ANSWERED (lib/ai/circuit.ts
    // PROVIDER_FAILURES) — it must never open the circuit on its own, or five people typing
    // something the union cannot parse would read as the provider itself being down.
    // (2026-10-06: this fake's `ai_calls` reads now filter by status/model for real — see `db()`
    // above — so this assertion exercises the actual rule instead of the fake's old blanket count.)
    expect(await recentFailureCount(client, "google")).toBe(0);
  });

  it("opens the circuit on a real provider failure, through the whole runTurn path", async () => {
    // 2026-10-06: this used to drive the failure with `notAStep` (a union-schema refusal), but
    // that is `schema_invalid` (lib/ai/circuit.ts PROVIDER_FAILURES excludes it on purpose — the
    // previous test above proves it stays at 0) and could only ever look like it opened the
    // circuit through this file's old `db()` fake, which ignored every `eq`/`in`/`gte` filter and
    // so returned the SAME total row count whatever status or model was actually asked for. Now
    // that `db()` filters for real, the circuit needs an actual provider failure to open.
    const { client } = db();
    const { deps, callGemini } = providerStubs();
    callGemini.mockRejectedValue(new Error("boom: the provider did not answer"));
    const args = { ...REQ, text: "what should I eat" };
    for (let i = 0; i < 5; i += 1) {
      await expect(runTurn(client, client, "u1", args,
        { generate: (a) => generateStructured(a, deps), ports, now: () => 0,
          classifyIntent: noClassify(), newId: () => "id-1" }))
        .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    }
    expect(await recentFailureCount(client, "google")).toBe(5);
    expect(callGemini).toHaveBeenCalledTimes(15);        // three attempts per turn
    await expect(runTurn(client, client, "u1", args,
      { generate: (a) => generateStructured(a, deps), ports, now: () => 0,
        classifyIntent: noClassify(), newId: () => "id-1" }))
      .rejects.toMatchObject({ status: 503, code: "coach_unavailable" });
    // The PRIMARY model's circuit is open, refused before any provider call on it — but
    // lib/ai/failures.ts isCapacityFailure treats an open circuit as worth trying the
    // same-key FALLBACK model (pre-existing rule, "the model is out, the key and the request are
    // not"), and that model's own circuit is still closed, so it gets its three attempts for real
    // before the turn gives up.
    expect(callGemini).toHaveBeenCalledTimes(18);
  });

});

describe("writeWeeklyReview through the real adapter", () => {
  it("routes the review to the Gemini stub and persists its model id", async () => {
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    callGemini.mockResolvedValueOnce({
      text: JSON.stringify({ wentWell: "protein", focus: "meal_timing" }),
      inputTokens: 30,
      outputTokens: 15,
    });
    await writeWeeklyReview(client, "u1", "2026-09-07",
      { generate: (args) => generateStructured(args, deps), latestEstimate: async () => null });

    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(loweredSchema(callGemini)).toMatchObject({
      type: "object", required: ["wentWell", "focus"],
    });
    expect(okRows(writes)).toHaveLength(1);
    expect(okRows(writes)[0].row).toMatchObject({ provider: "google", model_id: GEMINI_COACH });
    const message = writes.find((w) => w.table === "coach_messages")!.row;
    expect(message).toMatchObject({ model_id: GEMINI_COACH });
    expect(MODELS.weeklyReview).toBe(GEMINI_COACH);
  });
});

describe("scripts/ai-canary.ts", () => {
  const DOC = path.join(process.cwd(), "docs", "ai-data-handling.md");
  const DOC_HASH = createHash("sha256").update(readFileSync(DOC)).digest("hex");

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("writes no file when it runs, and leaves docs/ai-data-handling.md byte-identical", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const report = await canary(async () => ({
      probe: { ok: true, latencyMs: 12, detail: '{"ok":true}' },
      billing: "paid (no free-tier quota signal)",
    }));

    expect(report.exitCode).toBe(0);
    expect(createHash("sha256").update(readFileSync(DOC)).digest("hex")).toBe(DOC_HASH);
    expect(log).toHaveBeenCalledWith(
      "docs/ai-data-handling.md is not written by this canary; update it by hand.");
  });

  it("returns a failing exit code on an unpaid signal and still writes nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const report = await canary(async () => ({
      probe: { ok: false, latencyMs: 3, detail: "free tier quota exceeded" },
      billing: "UNPAID — free-tier quota reported",
    }));

    expect(report.exitCode).toBe(1);
    expect(createHash("sha256").update(readFileSync(DOC)).digest("hex")).toBe(DOC_HASH);
  });

  it("names a quota error it cannot attribute, and does not call it unpaid", async () => {
    // Grok pass 2, MEDIUM 9: "exceeded your current quota" is ALSO what a paid project answers
    // when it runs past its requests-per-minute. Refusing on it would fail the canary for a key
    // that is working; saying nothing would hide the one it exists to catch.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const { billingVerdict } = await import("@/scripts/ai-canary");
    const verdict = billingVerdict(
      "429 Too Many Requests: You exceeded your current quota, please check your plan and "
      + "billing details.");
    expect(verdict).toBe("quota exceeded — unpaid OR rate-capped; re-run in a minute");
  });

  it("does not refuse on a quota error it cannot attribute", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const report = await canary(async () => ({
      probe: { ok: true, latencyMs: 9, detail: "{}" },
      billing: "quota exceeded — unpaid OR rate-capped; re-run in a minute",
    }));
    expect(report.exitCode).toBe(0);
  });

  it("still refuses when the message names the free tier or billing", async () => {
    const { billingVerdict } = await import("@/scripts/ai-canary");
    for (const detail of [
      "RESOURCE_EXHAUSTED: generate_content_free_tier_requests quota exceeded",
      "Billing is not enabled for this project",
    ]) {
      expect(billingVerdict(detail)).toBe("UNPAID — free-tier quota reported");
    }
  });

  it("reads Google's current quota wording as UNPAID, not as an unknown failure", async () => {
    // The real 429 body from a billing-less project: no `free_tier` token anywhere in it.
    // Before T0 this exited 1 with "unknown — call failed" and never said the key was unpaid.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const report = await canary(async () => {
      const { billingVerdict: verdictOf } = await import("@/scripts/ai-canary");
      const detail = "429 RESOURCE_EXHAUSTED: You exceeded your current quota for "
        + "generate_content_free_tier_requests.";
      return {
        probe: { ok: false, latencyMs: 8, detail },
        billing: verdictOf(detail),
      };
    });

    expect(report.exitCode).toBe(1);
    expect(report.results[0].billing).toBe("UNPAID — free-tier quota reported");
    expect(errors.mock.calls.flat().join(" ")).toContain("unpaid project");
  });

  it("has no filesystem import at all, the structural reason it cannot overwrite the record", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts", "ai-canary.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|writeFile|writeFileSync/);
  });

  it("probes every distinct pinned model, not just MODELS.textToItems", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    const modelsProbed: string[] = [];
    const report = await canary(async (model: string) => {
      modelsProbed.push(model);
      return {
        probe: { ok: true, latencyMs: 1, detail: '{"ok":true}' },
        billing: "paid (no free-tier quota signal)",
      };
    });

    // MODELS pins GEMINI_FLASH (textToItems/voiceToItems/labelToNutrients/photoToItems) and
    // GEMINI_COACH (coach/weeklyReview) separately (lib/ai/models.ts) — a canary that only
    // probes one leaves the other's health unverified between manual runs (finding #87).
    expect(modelsProbed.sort()).toEqual([GEMINI_COACH, GEMINI_FLASH].sort());
    expect(report.exitCode).toBe(0);
  });
});

describe("the route override is atomic", () => {
  it("rejects a half-filled override at the type level", () => {
    const { client } = db();
    type Args = Parameters<typeof generateStructured>[0];
    const half: Args = {
      payload: coachTurnPayload(["hi"]), userId: "u1", schema: turnStepWireSchema,
      admin: client,
      // @ts-expect-error a route is a provider AND its model id, or no route at all.
      route: { provider: "google" },
    };
    expect(half.route).toEqual({ provider: "google" });
  });

  it("refuses a route whose model Gemini does not serve before any provider call", async () => {
    const { client, writes } = db();
    const { deps, callGemini } = providerStubs();
    await expect(generateStructured(
      { payload: coachTurnPayload(["hi"]), userId: "u1", schema: turnStepWireSchema,
        admin: client, route: { provider: "google", modelId: "not-a-gemini-model" } },
      deps
    )).rejects.toThrow("model 'not-a-gemini-model' is not served by provider 'google'");
    expect(callGemini).not.toHaveBeenCalled();
    expect(okRows(writes)).toHaveLength(0);
  });
});
