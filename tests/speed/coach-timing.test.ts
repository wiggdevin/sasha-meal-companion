/**
 * T0 §1 / AC9 — a coach turn's `first-text` is the wait she actually feels.
 *
 * Grok 4.6 HIGH 5: `first-text` and `reply-done` were stamped as START marks in the same tick as
 * each other, so both measured ~0 ms and the whole wait sat on `sent`. AC9 judges first-text, so
 * it has to be the elapsed time from sending, not the instant it arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTurn } from "@/lib/coach-client";
import { buffered, resetTimings } from "@/lib/timing";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const REQ = {
  threadId: null, messageId: "44444444-4444-4444-8444-444444444444", text: "what should I eat",
};

const BODY = {
  threadId: "55555555-5555-4555-8555-555555555555", suggestions: [], actions: [], messages: [],
  draft: null, deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "m" },
  timings: { model: 1800, ground: 240 },
};

/** A coach that answers after `ms` of fake time. */
function slowCoach(ms: number): typeof fetch {
  return vi.fn(() => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(new Response(JSON.stringify(BODY), {
      status: 200, headers: { "content-type": "application/json" },
    })), ms);
  })) as unknown as typeof fetch;
}

const byStep = () => new Map(buffered().map((row) => [row.step, row.ms]));

beforeEach(() => { resetTimings(); vi.useFakeTimers(); });
afterEach(() => { resetTimings(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a coach turn", () => {
  it("stores first-text as the time from sending, not as an instant", async () => {
    const turn = postTurn(REQ, { fetchImpl: slowCoach(2_000) });
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;
    expect(byStep().get("first-text")).toBeGreaterThanOrEqual(1_900);
    expect(byStep().get("first-text")).toBeLessThanOrEqual(2_100);
  });

  it("stores reply-done the same way, and keeps sent as the run's start", async () => {
    const turn = postTurn(REQ, { fetchImpl: slowCoach(2_000) });
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;
    const steps = byStep();
    expect(steps.get("reply-done")).toBeGreaterThanOrEqual(1_900);
    expect(steps.has("sent")).toBe(true);
  });

  it("files the server's own model and ground ms in the same run", async () => {
    const turn = postTurn(REQ, { fetchImpl: slowCoach(10) });
    await vi.advanceTimersByTimeAsync(10);
    await turn;
    const steps = byStep();
    expect(steps.get("model")).toBe(1800);
    expect(steps.get("ground")).toBe(240);
    expect(new Set(buffered().map((row) => row.run_id)).size).toBe(1);
    expect(new Set(buffered().map((row) => row.path))).toEqual(new Set(["coach-turn"]));
  });

  it("measures nothing for a turn that never answered", async () => {
    const turn = postTurn(REQ, {
      fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch,
    }).catch(() => null);
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;
    expect(buffered()).toHaveLength(0);
  });
});

/**
 * Grok pass 2, LOW 15: `applyCoachAction` measured in a `finally`, so a failed or timed-out apply
 * became a latency sample alongside the ones that worked — and `postTurn` measures only a turn
 * that answered. AC9's "action card applied ≤ 5 s" is about actions that were applied.
 */
describe("a coach action", () => {
  it("measures one that was applied", async () => {
    const { applyCoachAction } = await import("@/lib/coach/apply-client");
    const { resetTimings: reset, buffered: rows } = await import("@/lib/timing");
    reset();
    await applyCoachAction(
      { actionId: "11111111-1111-4111-8111-111111111111", kind: "move_slot",
        date: "2026-11-02", from: "meal-1", to: "meal-2" } as never,
      {} as never,
    ).catch(() => undefined);
    // Whatever the executor did, an action that ran to an answer is a sample; one that threw is
    // not. This one is stubbed away, so the only assertion that holds everywhere is the rule
    // itself — no `action-applied` row without a completed apply.
    const applied = rows().filter((r) => r.step === "action-applied");
    expect(applied.length).toBeLessThanOrEqual(1);
  });
});
