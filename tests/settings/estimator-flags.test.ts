import { afterEach, describe, expect, it } from "vitest";
import { canOpenTargetsSheet, visibleEstimate } from "@/lib/estimator-client";
import type { ExpenditureResponse, TargetsResponse } from "@/lib/api-types";
import { activityPromptUiEnabled } from "@/lib/activity/prompt-client";

const ESTIMATE: ExpenditureResponse = {
  status: "estimating", localDate: "2026-09-12", tdeeKcal: 2250, weightTrendKg: 57.4,
  confidence: 0.8, intakeCompleteness: 1, qualifiedDays: 21, weighInCount: 21,
  reason: null, engineVersion: "v1",
};
const CACHED = { asOf: "2026-09-12", value: ESTIMATE, stale: false };

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ESTIMATOR_UI;
  delete process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI;
});

describe("the activity prompt gate", () => {
  it("opens only for the literal string true", () => {
    delete process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI;
    expect(activityPromptUiEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI = "1";
    expect(activityPromptUiEnabled()).toBe(false);
    process.env.NEXT_PUBLIC_ACTIVITY_PROMPT_UI = "true";
    expect(activityPromptUiEnabled()).toBe(true);
  });
});

describe("the Settings estimator group (contracts §6)", () => {
  it("is hidden when NEXT_PUBLIC_ESTIMATOR_UI is unset, even with a real estimate", () => {
    delete process.env.NEXT_PUBLIC_ESTIMATOR_UI;
    expect(visibleEstimate(CACHED)).toBeNull();
  });

  it("is hidden before the estimate has loaded, even with the flag set", () => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
    expect(visibleEstimate(null)).toBeNull();
  });

  it("shows the estimate once the flag is set and data has loaded", () => {
    process.env.NEXT_PUBLIC_ESTIMATOR_UI = "1";
    expect(visibleEstimate(CACHED)).toEqual(ESTIMATE);
  });
});

describe("the Targets control (contracts §8)", () => {
  const TARGETS: TargetsResponse = {
    id: "t1", mode: "grams",
    resolved: {
      training: { kcal: 2400, protein: 135, fat: 70, carbs: 250 },
      rest: { kcal: 2100, protein: 135, fat: 70, carbs: 190 },
    },
    raisedToFloor: false,
  };

  it("cannot open when /api/targets has not returned anything (offline, 503, or error)", () => {
    expect(canOpenTargetsSheet(null)).toBe(false);
  });

  it("can open once targets have loaded", () => {
    expect(canOpenTargetsSheet(TARGETS)).toBe(true);
  });
});
