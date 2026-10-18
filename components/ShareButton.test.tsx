/**
 * Production smoke (settings-export, 2026-09-13): the share button was tapped and its label
 * never changed — no "Copied", no error copy, nothing. Tracing `handleShare`: when there is no
 * full week to summarize yet (`generateWeekSummary` returns "" — lib/summary.test.ts's "returns
 * an empty string for an empty week"), the handler does `if (!text) return;` and stops before
 * touching `navigator.share`/`navigator.clipboard` or `status` at all. That silently-no-ops class
 * of bug is exactly audit finding 41 (see components/QuickActions.test.tsx's header comment) —
 * a tap that does nothing and gives no feedback. `statusForEmptyShare` and `shareButtonLabel` are
 * pulled out of the component so the "nothing to share yet" case is checkable without a DOM (no
 * @testing-library/react in this repo — tests/today/day-type-toggle.test.tsx's header comment is
 * the canonical note on why).
 */
import { describe, expect, it } from "vitest";
import { shareButtonLabel, shareFailure, statusForEmptyShare } from "./ShareButton";

describe("statusForEmptyShare", () => {
  it("flags nothing-to-share when there is no summary text yet", () => {
    expect(statusForEmptyShare("")).toBe("empty");
  });

  it("stays out of the way once there is a real week to send", () => {
    expect(statusForEmptyShare("Sep 14–20 · 5 meals logged")).toBeNull();
  });
});

describe("shareButtonLabel", () => {
  it("says when there is nothing to share yet", () => {
    expect(shareButtonLabel("empty")).toBe("Nothing to share yet");
  });

  it("keeps the existing idle/copied/error copy", () => {
    expect(shareButtonLabel("idle")).toBe("Share my week");
    expect(shareButtonLabel("copied")).toBe("Copied — ready to paste");
    expect(shareButtonLabel("error")).toBe("Couldn't copy — try again");
  });
});

describe("shareFailure", () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("treats a dismissed share sheet as a choice, not a failure", () => {
    expect(shareFailure(named("AbortError"))).toBe("cancelled");
    expect(shareFailure({ name: "AbortError" })).toBe("cancelled");
  });

  it("falls back to the clipboard for any other failure", () => {
    expect(shareFailure(named("NotAllowedError"))).toBe("clipboard");
    expect(shareFailure(new TypeError("bad data"))).toBe("clipboard");
    expect(shareFailure(named("DataError"))).toBe("clipboard");
    expect(shareFailure("boom")).toBe("clipboard");
  });
});
