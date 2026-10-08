// 2026-10-07 QA: a 68 kg answer was stored as 67.993 kg. The onboarding state seeds its weight
// text in pounds rounded to 0.1 ("149.9"), and reading that text back lost the exact value.
import { describe, expect, it } from "vitest";
import {
  createOnboardingState, onboardingReducer, parsedWeightKg, weightLbFor,
} from "@/lib/profile/onboarding-state";
import { defaultStore } from "@/lib/store";

const base = () => ({ ...defaultStore().settings, weightKg: 68, weightUnit: "lb" as const });

describe("onboarding weight seed", () => {
  it("an untouched seeded weight keeps its exact kilograms", () => {
    const state = createOnboardingState(base(), 5);
    expect(state.weight).toBe("149.9");
    expect(parsedWeightKg(state)).toBe(68);
    expect(weightLbFor(state)! / 2.2046226218).toBeCloseTo(68, 6);
  });

  it("a unit switch both ways keeps the exact value", () => {
    let state = createOnboardingState(base(), 5);
    state = onboardingReducer(state, { type: "set_weight_unit", value: "kg" });
    expect(state.weight).toBe("68");
    state = onboardingReducer(state, { type: "set_weight_unit", value: "lb" });
    expect(state.weight).toBe("149.9");
    expect(parsedWeightKg(state)).toBe(68);
  });

  it("a typed edit wins over the seed", () => {
    const state = onboardingReducer(createOnboardingState(base(), 5), { type: "edit_weight", value: "150" });
    expect(parsedWeightKg(state)).toBe(68.039);
  });
});
