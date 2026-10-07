/**
 * The 2026-09-13 three-minute hang. lib/coach/turn.ts only consults the wall-clock budget
 * BETWEEN turn steps, so a provider request that never returns cannot be interrupted by it.
 * With RETRIES = 2 the adapter makes three such attempts, each previously unbounded.
 *
 * generateStructured must therefore bound each attempt itself, and record the failure as a
 * "timeout" ai_calls row rather than hanging the request.
 */
import { withSpendRpc } from "@/tests/ai/spend-admin";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { describe, expect, it, vi } from "vitest";
import { generateStructured } from "@/lib/ai/adapter";
import { PER_CALL_TIMEOUT_MS } from "@/lib/coach/turn";
import { z } from "zod";

function admin(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, neq: () => chain, gte: () => chain, is: () => chain,
    order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (r: (v: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(r),
    insert: (row: unknown) => { rows.push(row); return chain; },
  });
  return withSpendRpc({ from: () => chain, rpc: async () => ({ data: null, error: null }) }) as never;
}

describe("provider call deadline", () => {
  it("has a per-call timeout well under the turn's wall clock", async () => {
    const { TURN_LIMITS } = await import("@/lib/coach/turn");
    expect(PER_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PER_CALL_TIMEOUT_MS).toBeLessThan(TURN_LIMITS.wallClockMs);
  });

  it("gives up on a provider call that never returns, instead of hanging", async () => {
    vi.useFakeTimers();
    const rows: unknown[] = [];
    // A provider that never settles — the shape of the production hang.
    const callGemini = vi.fn(() => new Promise<never>(() => {}));

    const promise = generateStructured({
      payload: coachTurnPayload(["hi"]), userId: "u1", admin: admin(rows),
      schema: z.object({ ok: z.boolean() }),
      timeoutMs: 50,
    } as never, { callGemini: callGemini as never });

    const settled = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    vi.useRealTimers();

    // The failure is durably recorded as a timeout, not lost.
    const statuses = rows.map((r) => (r as { status?: string }).status);
    expect(statuses).toContain("timeout");
  }, 20_000);
});
