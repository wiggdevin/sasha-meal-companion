/**
 * W068: a caller's abort stops the call. No retry starts after it, a send still in flight cannot
 * leave an unhandled rejection, and the row it leaves (`caller_abort`) is never counted by the
 * circuit breaker, so five stopped calls do not shut a healthy provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLER_ABORT_ERROR, callModel, ProviderHttpError, type ModelCall } from "@/lib/ai/call";
import { assertCircuitClosed } from "@/lib/ai/circuit";

type Row = Record<string, unknown>;

/** The ledger the call reads and writes: the spend RPCs, `ai_calls` inserts and the circuit read. */
function fakeAdmin(rows: Row[]) {
  return {
    rpc: async (fn: string) => {
      if (fn.startsWith("ai_spend_reserve")) {
        return { data: [{ reservation_id: crypto.randomUUID(), allowed: true, reason: null,
          user_committed_usd: 0, global_committed_usd: 0 }], error: null };
      }
      return { data: true, error: null };
    },
    from: () => ({
      insert: async (row: Row) => { rows.push({ ...row, created_at: new Date().toISOString() }); return { error: null }; },
      select: () => {
        const where: Record<string, unknown> = {};
        let statuses: string[] = [];
        const chain = {
          eq: (col: string, val: unknown) => { where[col] = val; return chain; },
          in: (_col: string, vals: string[]) => { statuses = vals; return chain; },
          gte: async () => ({ error: null, data: rows.filter((r) => statuses.includes(String(r.status))
            && Object.entries(where).every(([k, v]) => r[k] === v)) }),
        };
        return chain;
      },
    }),
  };
}

type Result = { inputTokens: number; outputTokens: number };

function call(rows: Row[], overrides: Partial<ModelCall<Result, string>>): ModelCall<Result, string> {
  return {
    payload: { purpose: "coach-verify" },
    provenance: () => "coach-verify",
    target: () => ({ provider: "typesafe", model: "jev-test", sdkVersion: "test" }),
    ledger: () => ({ userId: "user-1", admin: fakeAdmin(rows) as never }),
    inputHash: () => "\\x00",
    maxAttemptCostUsd: () => 0.001,
    policy: { attempts: 2, budgetMs: 5_000, attemptMs: 5_000, backoffMs: [400], retryable: () => true },
    transport: { send: async () => { throw new ProviderHttpError(503, "HTTP 503"); } },
    accept: () => "ok",
    price: () => 0,
    ...overrides,
  };
}

describe("a caller abort (W068)", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); });

  it("during the backoff starts no second attempt and leaves no unhandled rejection", async () => {
    const rows: Row[] = [];
    const controller = new AbortController();
    const send = vi.fn(async () => { throw new ProviderHttpError(503, "HTTP 503"); });
    // The backoff never ends by itself: only the abort can release it.
    const sleep = () => { controller.abort(); return new Promise<void>(() => undefined); };
    await expect(callModel(call(rows, { signal: controller.signal, transport: { send },
      policy: { attempts: 3, budgetMs: 5_000, attemptMs: 5_000, backoffMs: [400, 400], retryable: () => true, sleep } })))
      .rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    // The first attempt's 503 was the provider's own: the later abort does not hide it.
    expect(rows[0]).toMatchObject({ status: "provider_error", error: "HTTP 503" });
    expect(unhandled).toEqual([]);
  });

  it("while a send is in flight rejects at once, and the send's later failure is handled", async () => {
    const rows: Row[] = [];
    const controller = new AbortController();
    let failLater: (e: Error) => void = () => undefined;
    // A transport that ignores its abort signal and fails long after the caller left.
    const send = vi.fn(() => new Promise<Result>((_, reject) => { failLater = reject; }));
    const done = callModel(call(rows, { signal: controller.signal, transport: { send } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    failLater(new ProviderHttpError(503, "HTTP 503"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ error: CALLER_ABORT_ERROR });
    expect(unhandled).toEqual([]);
  });

  it("during the transport's open step sends nothing", async () => {
    const rows: Row[] = [];
    const controller = new AbortController();
    const send = vi.fn(async () => ({ inputTokens: 1, outputTokens: 1 }));
    await expect(callModel(call(rows, { signal: controller.signal,
      transport: { open: async () => { controller.abort(); }, send } }))).rejects.toMatchObject({ name: "AbortError" });
    expect(send).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ error: CALLER_ABORT_ERROR });
  });

  it("five of them leave the circuit closed; five provider failures open it", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const send = () => { setTimeout(() => controller.abort(), 0); return new Promise<Result>(() => undefined); };
      await callModel(call(rows, { signal: controller.signal, transport: { send } })).catch(() => undefined);
    }
    expect(rows.every((row) => row.error === CALLER_ABORT_ERROR)).toBe(true);
    expect(rows).toHaveLength(5);
    const admin = fakeAdmin(rows) as never;
    await expect(assertCircuitClosed(admin, "typesafe", "jev-test")).resolves.toBeUndefined();

    for (let i = 0; i < 5; i++) {
      await callModel(call(rows, { policy: { attempts: 1, budgetMs: 5_000, attemptMs: 5_000,
        backoffMs: [], retryable: () => false } })).catch(() => undefined);
    }
    await expect(assertCircuitClosed(admin, "typesafe", "jev-test")).rejects.toThrow(/circuit open/);
  });

  it("a deadline the caller set as its own latency budget is recorded as a caller abort", async () => {
    const rows: Row[] = [];
    const send = vi.fn(() => new Promise<Result>(() => undefined));
    await expect(callModel(call(rows, { callerDeadline: true, transport: { send },
      policy: { attempts: 1, budgetMs: 20, attemptMs: 20, backoffMs: [], retryable: () => false } })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(rows[0]).toMatchObject({ status: "timeout", error: CALLER_ABORT_ERROR });
  });

  it("a provider failure before a caller-deadline timeout is still recorded as the provider's", async () => {
    const rows: Row[] = [];
    let n = 0;
    const send = vi.fn(() => (n++ === 0 ? Promise.reject(new ProviderHttpError(529, "HTTP 529"))
      : new Promise<Result>(() => undefined)));
    await callModel(call(rows, { callerDeadline: true, transport: { send },
      policy: { attempts: 2, budgetMs: 200, attemptMs: 50, backoffMs: [0], retryable: () => true } }))
      .catch(() => undefined);
    expect(send).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ status: "provider_error", error: "HTTP 529" });
  });

  it("an ordinary deadline still counts as a provider timeout", async () => {
    const rows: Row[] = [];
    const send = vi.fn(() => new Promise<Result>(() => undefined));
    await callModel(call(rows, { transport: { send },
      policy: { attempts: 1, budgetMs: 20, attemptMs: 20, backoffMs: [], retryable: () => false } })).catch(() => undefined);
    expect(rows[0]).toMatchObject({ status: "timeout" });
    expect(rows[0].error).not.toBe(CALLER_ABORT_ERROR);
  });
});
