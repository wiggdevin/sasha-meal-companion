import { describe, expect, it } from "vitest";
import { needsActivityContext } from "@/scripts/eval/coach-streak-branch";

// Regression for coach-eval run turn 2 (2026-10-03): the default (category === null) streak
// draws from every corpus category, including the single "activity" case
// (activity-device-kcal-no-allowance). openHarness only turned on
// COACH_ACTIVITY_CONTEXT_ENABLED when `config.category === "activity"`, so that case timed out
// (30675 ms vs a 15000 ms bound) with no activity block in context on the default run. A
// dedicated `--category activity` run never surfaced this because it always drew the same case
// with the flag already on.
describe("coach streak activity context enablement", () => {
  it("enables activity context for a dedicated activity run", () => {
    expect(needsActivityContext("activity")).toBe(true);
  });

  it("enables activity context for the default run, which can draw the lone activity case", () => {
    expect(needsActivityContext(null)).toBe(true);
  });

  it("leaves activity context off for every other single-category run", () => {
    const others = [
      "devin", "list_edit", "schedule_body", "suggestion", "no_action", "block", "jev", "meals",
    ] as const;
    for (const category of others) {
      expect(needsActivityContext(category)).toBe(false);
    }
  });
});
