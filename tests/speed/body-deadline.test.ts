/**
 * A body that never arrives is a timeout, for every client (Grok pass 26, HIGH 2).
 *
 * T0 §2 gives each hop a budget, and since the budget covers the body read the deadline can now
 * land on `res.json()` rather than on the request. Every caller reads its body outside the catch
 * that maps a deadline, so the same stall reached her as a generic failure — or, worse, as a
 * parsed answer that never came. Each of these drives the same shape: headers at once, a body
 * that never arrives, and the answer a header timeout would have given.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { captureText } from "@/lib/capture-client";
import { searchFoods } from "@/lib/catalog-client";
import { scanGtin, ScanUnavailable } from "@/lib/barcode/client";
import { postTurn, CoachError } from "@/lib/coach-client";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { resetTimings } from "@/lib/timing";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

/** Headers now, and a body that never comes. */
function stalls(status = 200) {
  return vi.fn(async () => new Response(
    new ReadableStream({ start() { /* nothing, ever */ } }),
    { status, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
}

const CTX = { localDate: "2026-09-17", tz: "UTC", slot: "meal-2" as const };

beforeEach(() => { vi.useFakeTimers(); resetTimings(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function past(budget: keyof typeof DEADLINES): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEADLINES[budget] + 1);
}

describe("a body that never arrives", () => {
  it("reads as the capture timeout, not as an answer", async () => {
    const outcome = captureText("two eggs", { ...CTX, fetchFn: stalls() });
    await past("propose");
    expect(await outcome).toEqual({
      kind: "error", status: 0, message: "Capture is resting, try search" });
  });

  it("reads as the capture timeout on an error status too", async () => {
    // `errorFrom` swallowed the failed read and answered from the status alone, so a stall on a
    // 500 came back as the generic line rather than the one the timeout owns.
    const outcome = captureText("two eggs", { ...CTX, fetchFn: stalls(500) });
    await past("propose");
    expect(await outcome).toEqual({
      kind: "error", status: 0, message: "Capture is resting, try search" });
  });

  it("falls back to the foods on this phone for a search", async () => {
    const result = searchFoods("rice", { fetchImpl: stalls(), mine: {} });
    await past("search");
    const answered = await result;
    expect(answered.kind).toBe("offline");
  });

  it("is a scan the sheet can fall back from", async () => {
    const scan = scanGtin({ gtin: "00000000000000" }, { fetchImpl: stalls() })
      .catch((e: unknown) => e);
    await past("barcode");
    expect(await scan).toBeInstanceOf(ScanUnavailable);
  });

  it("is a coach turn she can send again", async () => {
    const turn = postTurn({ text: "what now" } as never, { fetchImpl: stalls() })
      .catch((e: unknown) => e);
    await past("coach");
    const error = await turn;
    expect(error).toBeInstanceOf(CoachError);
    expect((error as CoachError).status).toBe(503);
  });
});
