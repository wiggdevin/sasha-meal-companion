/**
 * W065: the Plan panel's propose step ends when the draft is shown, not when the person confirms.
 * `proposePlate` / `proposeDescribed` hand the draft to PanelReview and hold the capture's run open
 * until `commitPanelDraft` closes it. Without a `confirm-shown` mark the `propose` row ran on until
 * the commit mark, so production `text` propose read 27-39 s for a 1.8 s model call: the person's
 * review time, not the server's. The capture sheet already marks it (components/CaptureSheet.tsx).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { beginRun, mark, measure, resetTimings, type TimingPath } from "@/lib/timing";

vi.mock("@/lib/capture-client", async (original) => ({
  ...(await original<typeof import("@/lib/capture-client")>()),
  captureText: vi.fn(),
  captureMedia: vi.fn(),
}));

const { captureMedia, captureText } = await import("@/lib/capture-client");
const { proposeDescribed, proposePlate } = await import("@/lib/plan/photo-log");

function outcomeOn(path: TimingPath) {
  const run = beginRun(path);
  mark(path, "propose", run);
  return { run, outcome: {
    kind: "draft", run,
    draft: { draftId: "d1", method: path, items: [{ seq: 0, grams: 150, foodRefId: "ref-1", label: "chicken",
      policy: { verdict: "allowed" } }] },
  } as never };
}

const noFetch = (async () => new Response(null, { status: 202 })) as typeof fetch;

afterEach(() => { unbindAccount(); resetTimings(); vi.useRealTimers(); });

describe("Plan panel timing (W065)", () => {
  it.each([
    ["text", () => proposeDescribed(bindAccount("user-a"), "grilled chicken", "meal-2")],
    ["photo", () => proposePlate(bindAccount("user-a"), new Blob(["x"]), "meal-2", 1)],
  ] as const)("closes the %s propose hop when the draft is ready to show", async (path, propose) => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    const { run, outcome } = outcomeOn(path);
    vi.mocked(path === "text" ? captureText : captureMedia).mockImplementation(async () => {
      vi.advanceTimersByTime(2_000); // the server's answer
      return outcome;
    });
    const proposal = await propose();
    expect(proposal.ok).toBe(true);
    vi.advanceTimersByTime(25_000); // the person reads the draft, then confirms
    mark(path, "commit", run);
    const rows = measure(path, run, undefined, { fetchImpl: noFetch });
    const ms = Object.fromEntries(rows.map((r) => [r.step, r.ms]));
    expect(ms.propose).toBe(2_000);
    expect(ms["confirm-shown"]).toBe(25_000);
  });

  it("marks nothing when the capture failed (no run to close)", async () => {
    vi.mocked(captureText).mockResolvedValue({ kind: "error", status: 0, message: "no" } as never);
    const proposal = await proposeDescribed(bindAccount("user-a"), "x", "meal-2");
    expect(proposal.ok).toBe(false);
  });
});
