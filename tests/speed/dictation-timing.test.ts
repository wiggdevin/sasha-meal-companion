/**
 * T7 §1 / AC7 — a spoken turn files one `dictation` step on path `coach-turn`, in the SAME run as
 * the turn it started. `components/CoachMic.tsx` makes exactly these three calls around `postTurn`.
 *
 * The mark at press time is replaced by a measured duration at the final transcript, because the
 * hop ENDS there: on the fallback path the turn is not sent until she taps Send, and a mark alone
 * would charge her reading time to the dictation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTurn } from "@/lib/coach-client";
import { TIMING_STEPS, buffered, discardRun, markMs, resetTimings } from "@/lib/timing";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const REQ = {
  threadId: null, messageId: "77777777-7777-4777-8777-777777777777", text: "add watermelon",
};
const BODY = {
  threadId: "88888888-8888-4888-8888-888888888888", suggestions: [], actions: [], messages: [],
  draft: null, deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "m" },
};
const coach: typeof fetch = vi.fn(async () => new Response(JSON.stringify(BODY), {
  status: 200, headers: { "content-type": "application/json" },
})) as unknown as typeof fetch;

/** What `lib/coach/hold.ts` files when the transcript lands: release → transcript (§4). */
function heard(ms: number): void { markMs("coach-turn", "dictation", ms); }

beforeEach(() => { resetTimings(); });
afterEach(() => { resetTimings(); vi.restoreAllMocks(); });

describe("the dictation hop", () => {
  it("is part of the timing vocabulary, before the turn's own steps", () => {
    expect(TIMING_STEPS).toContain("dictation");
    expect(TIMING_STEPS.indexOf("dictation")).toBeLessThan(TIMING_STEPS.indexOf("sent"));
  });

  it("lands on path coach-turn, in the same run as the turn it started", async () => {
    heard(1_450);
    await postTurn(REQ, { fetchImpl: coach });
    const rows = buffered();
    const dictation = rows.find((row) => row.step === "dictation");
    expect(dictation?.ms).toBe(1_450);
    expect(dictation?.path).toBe("coach-turn");
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(1);
    expect(rows.map((row) => row.step)).toContain("sent");
  });

  it("files the measured duration once, never twice", async () => {
    heard(900);
    await postTurn(REQ, { fetchImpl: coach });
    expect(buffered().filter((row) => row.step === "dictation")).toHaveLength(1);
  });

  it("leaves nothing behind for the next typed turn when the hold was abandoned", async () => {
    heard(700);
    discardRun("coach-turn");
    await postTurn(REQ, { fetchImpl: coach });
    expect(buffered().some((row) => row.step === "dictation")).toBe(false);
  });
});
