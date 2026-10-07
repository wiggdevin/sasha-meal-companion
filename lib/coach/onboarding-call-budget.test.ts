import { describe, expect, it } from "vitest";
import {
  ONBOARDING_MAX_MODEL_CALLS, onboardingCallBudgetRemaining,
} from "@/lib/coach/onboarding-call-budget";

describe("onboardingCallBudgetRemaining", () => {
  it("allows calls while under the cap", () => {
    for (let used = 0; used < ONBOARDING_MAX_MODEL_CALLS; used += 1) {
      expect(onboardingCallBudgetRemaining(used)).toBe(true);
    }
  });

  it("refuses at and past the cap", () => {
    expect(onboardingCallBudgetRemaining(ONBOARDING_MAX_MODEL_CALLS)).toBe(false);
    expect(onboardingCallBudgetRemaining(ONBOARDING_MAX_MODEL_CALLS + 1)).toBe(false);
  });

  it("refuses a non-finite count rather than allow an unbounded call", () => {
    expect(onboardingCallBudgetRemaining(NaN)).toBe(false);
    expect(onboardingCallBudgetRemaining(Infinity)).toBe(false);
  });
});
