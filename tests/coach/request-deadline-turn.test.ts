/**
 * Every await on the turn path is bounded by a deadline counted from request arrival (Sol r4).
 * Fake timers: a read that never answers is a read that never answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import { COACH_RESPONSE_DEADLINE_MS, TURN_LIMITS, TURN_REPLY_DEADLINE_MS,
  TURN_SAVE_DEADLINE_MS } from "@/lib/coach/turn";

const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000040";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000041";
const never = new Promise<never>(() => {});

/** Rows per table; `stall` lists `table:kind` pairs (select | insert | update) that never answer. */
function db(tables: Record<string, unknown[]>, stall: string[] = []) {
  const api = (table: string) => {
    let kind = "select";
    const chain: Record<string, unknown> = {};
    const answer = <T,>(value: T) => stall.includes(`${table}:${kind}`) ? never : Promise.resolve(value);
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain, gte: () => chain,
      lte: () => chain, order: () => chain, limit: () => chain, delete: () => chain,
      insert: () => { kind = "insert"; return chain; },
      update: () => { kind = "update"; return chain; },
      maybeSingle: () => answer({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: () => answer({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        answer({ data: kind === "select" ? tables[table] ?? [] : null, error: null })
          .then(resolve, reject),
    });
    return chain;
  };
  return { from: (table: string) => api(table), rpc: async () => ({ data: null, error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-23", nutrients: [] }),
  weekTotals: async () => [], activeTargets: async () => null,
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [], getConstraints: async () => ({}), recentGut: async () => [],
  newDraftId: () => "draft-1",
};

/** The promise's outcome once `ms` of fake time has passed, or "pending". */
async function after(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let outcome: unknown = "pending";
  promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

const noIntent = () => vi.fn().mockResolvedValue(null) as never;

describe("turn deadlines from request arrival", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("COACH_ENABLED", "1"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("orders the budgets: loop, reply, save, response", () => {
    expect(TURN_LIMITS.wallClockMs).toBeLessThan(TURN_REPLY_DEADLINE_MS);
    expect(TURN_REPLY_DEADLINE_MS).toBeLessThan(TURN_SAVE_DEADLINE_MS);
    expect(TURN_SAVE_DEADLINE_MS).toBeLessThan(COACH_RESPONSE_DEADLINE_MS);
  });

  it("counts the budget from the startedAt the route passes in", async () => {
    const generate = vi.fn();
    const startedAt = Date.now() - TURN_LIMITS.wallClockMs;   // auth and parsing took it all
    const turn = runTurn(db({}), db({}), "u1", { threadId: null, messageId: MESSAGE, text: "hi" },
      { generate: generate as never, ports, newId: () => THREAD, startedAt,
        classifyIntent: noIntent() });
    const outcome = await after(turn, 10);
    expect(generate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ value: { messages: [{}, {
      content: expect.stringContaining("took too long") }] } });
  });

  it("replays a stored turn without waiting for the profile read", async () => {
    const tables = { coach_threads: [{ id: THREAD, user_id: "u1", kind: "chat" }], coach_messages: [
      { id: MESSAGE, thread_id: THREAD, role: "user", content: "hi", seq: 1 },
      { id: THREAD, thread_id: THREAD, role: "assistant", content: "Hello.", seq: 2, tool_calls: [] },
    ] };
    const stalls = ["constraint_profiles:select"];
    const turn = runTurn(db(tables, stalls), db(tables, stalls), "u1",
      { threadId: null, messageId: MESSAGE, text: "hi" },
      { generate: vi.fn() as never, ports, newId: () => THREAD, startedAt: Date.now(),
        classifyIntent: noIntent() });
    expect(await after(turn, 10)).toMatchObject({ value: { threadId: THREAD } });
  });

  it("deflects without waiting for the profile read", async () => {
    const stalls = ["constraint_profiles:select"];
    const turn = runTurn(db({}, stalls), db({}, stalls), "u1",
      { threadId: null, messageId: MESSAGE, text: "is my colitis getting worse?" },
      { generate: vi.fn() as never, ports, newId: () => THREAD, startedAt: Date.now(),
        classifyIntent: noIntent() });
    expect(await after(turn, 10)).toMatchObject({ value: { deflected: true } });
  });

  it("answers without the day context when its read stalls", async () => {
    const stalls = ["user_food_prefs:select", "recipes:select"];
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Hello." });
    const turn = runTurn(db({}, stalls), db({}, stalls), "u1",
      { threadId: null, messageId: MESSAGE, text: "hi" },
      { generate: generate as never, ports, newId: () => THREAD, startedAt: Date.now(),
        classifyIntent: noIntent() });
    expect(await after(turn, TURN_LIMITS.wallClockMs)).not.toBe("pending");
  });

  it("gives up on a stalled save with a retryable 503 by the save deadline", async () => {
    const stalls = ["coach_messages:insert"];
    const generate = vi.fn().mockResolvedValue({ kind: "final", text: "Hello." });
    const turn = runTurn(db({}, stalls), db({}, stalls), "u1",
      { threadId: null, messageId: MESSAGE, text: "hi" },
      { generate: generate as never, ports, newId: () => THREAD, startedAt: Date.now(),
        classifyIntent: noIntent() });
    expect(await after(turn, TURN_SAVE_DEADLINE_MS))
      .toMatchObject({ error: { status: 503, code: "timeout" } });
  });
});
