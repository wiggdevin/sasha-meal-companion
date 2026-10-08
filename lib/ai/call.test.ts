/**
 * 2026-10-02 DeepSeek audit: callModel's failure record (the `attempt` loop's final `record` call)
 * priced a failed call from `billed` tokens alone, dropping `surchargeUsd` — the real dollar cost
 * OpenRouter (or any surcharge-priced lane) already billed on an ANSWERED attempt whose own
 * `accept()` then rejected it (a 200 whose JSON fails the schema). The daily spend cap
 * (lib/ai/spend.ts assertUnderSpendCap) reads this `cost_estimate`, so it silently under-counted
 * real spend on every schema-invalid OpenRouter reply.
 *
 * Generic to callModel, not OpenRouter-specific: a hand-built ModelCall with its own `retryable`,
 * so the test controls exactly how many attempts answer and how many of those answers accept.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callModel, SchemaRejection } from "@/lib/ai/call";
import { coachOpenRouterPayload, openRouterProvenance } from "@/lib/ai/openrouter-payloads";
import { spendAdmin } from "@/tests/ai/spend-admin";

function attest(): void {
  vi.stubEnv("OPENROUTER_ATTESTED", "1");
}

type FakeResult = { inputTokens: number; outputTokens: number; costUsd: number };

describe("callModel's failure record carries every answered attempt's real surcharge cost", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("accumulates two schema-invalid OpenRouter answers' $0.01 surcharges into one $0.02 failure row", async () => {
    attest();
    const inserted: Record<string, unknown>[] = [];
    const admin = spendAdmin([], inserted);
    const payload = coachOpenRouterPayload(["USER: hi"]);
    let sent = 0;

    const error = await callModel<FakeResult, never>({
      payload,
      provenance: openRouterProvenance,
      target: () => ({ provider: "openrouter", model: "openai/gpt-5-mini", sdkVersion: "test" }),
      ledger: () => ({ userId: "u1", admin: admin as never }),
      inputHash: () => `\\x${createHash("sha256").update(payload.text).digest("hex")}`,
      policy: {
        attempts: 2, budgetMs: 5_000, attemptMs: 2_000, backoffMs: [0],
        // A schema rejection is normally ours and not worth a retry (lib/ai/openrouter.ts); this
        // test retries it on purpose, to prove callModel's generic accounting across TWO answered
        // attempts, not to claim OpenRouter itself retries this way.
        retryable: (e) => e instanceof SchemaRejection,
      },
      transport: {
        send: async () => { sent += 1; return { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }; },
      },
      accept: () => { throw new SchemaRejection("model output failed the schema"); },
      price: () => 0,
      surchargeUsd: (result) => result.costUsd,
      maxAttemptCostUsd: () => 0.05,
    }).catch((e: unknown) => e);

    expect(sent).toBe(2);
    expect(error).toBeInstanceOf(SchemaRejection);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: "schema_invalid", input_tokens: 20, output_tokens: 10 });
    expect(inserted[0].cost_estimate).toBeCloseTo(0.02, 6);
  });
});

describe("callModel asks beforeRetry before every retry and stops when it says no", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  function run(beforeRetry: () => Promise<boolean>) {
    attest();
    const inserted: Record<string, unknown>[] = [];
    const admin = spendAdmin([], inserted);
    const payload = coachOpenRouterPayload(["USER: hi"]);
    const state = { sent: 0, inserted };
    const done = callModel<FakeResult, never>({
      payload,
      provenance: openRouterProvenance,
      target: () => ({ provider: "openrouter", model: "openai/gpt-5-mini", sdkVersion: "test" }),
      ledger: () => ({ userId: "u1", admin: admin as never }),
      inputHash: () => `\\x${createHash("sha256").update(payload.text).digest("hex")}`,
      policy: { attempts: 3, budgetMs: 5_000, attemptMs: 2_000, backoffMs: [0, 0],
        retryable: () => true, beforeRetry },
      transport: { send: async () => { state.sent += 1; throw new Error("boom"); } },
      accept: () => { throw new Error("unreachable"); },
      price: () => 0,
      maxAttemptCostUsd: () => 0.05,
    }).catch((e: unknown) => e);
    return { done, state };
  }

  it("is never asked before the first attempt, and is asked before each retry", async () => {
    const beforeRetry = vi.fn(async () => true);
    const { done, state } = run(beforeRetry);
    expect(await done).toBeInstanceOf(Error);
    expect(state.sent).toBe(3);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
  });

  it("a refused retry is never sent, and the last real failure is still recorded once", async () => {
    const beforeRetry = vi.fn(async () => false);
    const { done, state } = run(beforeRetry);
    const error = await done;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    expect(state.sent).toBe(1);
    expect(state.inserted).toHaveLength(1);
  });
});

describe("followups #14: a transport.open() failure is classified and recorded, same as a send() failure", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("records a permission_denied row from an open() throw, so assertCircuitClosed can see it", async () => {
    attest();
    const inserted: Record<string, unknown>[] = [];
    const admin = spendAdmin([], inserted);
    const payload = coachOpenRouterPayload(["USER: hi"]);
    let sent = 0;
    const deniedError = Object.assign(new Error("PERMISSION_DENIED: Your project has been denied access."),
      { status: 403 });

    const error = await callModel<FakeResult, never>({
      payload,
      provenance: openRouterProvenance,
      target: () => ({ provider: "openrouter", model: "openai/gpt-5-mini", sdkVersion: "test" }),
      ledger: () => ({ userId: "u1", admin: admin as never }),
      inputHash: () => `\\x${createHash("sha256").update(payload.text).digest("hex")}`,
      policy: { attempts: 3, budgetMs: 5_000, attemptMs: 2_000, backoffMs: [0, 0], retryable: () => true },
      transport: {
        // open() fails before any attempt ever reaches send() -- the Files-API-upload shape of
        // the gap this closes.
        open: async () => { throw deniedError; },
        send: async () => { sent += 1; return { inputTokens: 0, outputTokens: 0, costUsd: 0 }; },
      },
      accept: () => { throw new Error("never reached"); },
      price: () => 0,
      maxAttemptCostUsd: () => 0.05,
    }).catch((e: unknown) => e);

    expect(sent).toBe(0); // open() never got far enough to call send() even once.
    expect(error).toBe(deniedError);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: "permission_denied", input_tokens: 0, output_tokens: 0,
      error: deniedError.message });
  });

  it("records an ordinary open() failure as a generic error row, not permission_denied", async () => {
    attest();
    const inserted: Record<string, unknown>[] = [];
    const admin = spendAdmin([], inserted);
    const payload = coachOpenRouterPayload(["USER: hi"]);
    const networkError = new Error("getaddrinfo ENOTFOUND");

    const error = await callModel<FakeResult, never>({
      payload,
      provenance: openRouterProvenance,
      target: () => ({ provider: "openrouter", model: "openai/gpt-5-mini", sdkVersion: "test" }),
      ledger: () => ({ userId: "u1", admin: admin as never }),
      inputHash: () => `\\x${createHash("sha256").update(payload.text).digest("hex")}`,
      policy: { attempts: 1, budgetMs: 5_000, attemptMs: 2_000, backoffMs: [0], retryable: () => true },
      transport: { open: async () => { throw networkError; }, send: async () => { throw new Error("unreached"); } },
      accept: () => { throw new Error("never reached"); },
      price: () => 0,
      maxAttemptCostUsd: () => 0.05,
    }).catch((e: unknown) => e);

    expect(error).toBe(networkError);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ status: "error" });
  });
});
