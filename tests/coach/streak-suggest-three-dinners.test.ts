import { describe, expect, it } from "vitest";
import { targetRevisionFixture } from "@/scripts/eval/coach-streak-target-fixture";

// Regression for coach-eval run turn 29 (2026-10-03): seedRehearsal never persisted a
// target_profiles revision, only user_settings. Post target-authority-boundary
// (docs/decisions/2026-09-22-target-priors.md), compose_meal/suggest_options never invent
// numbers from user_settings alone -- without an effective target_profiles row the coach answers
// "Your targets aren't set yet. Finish your profile and I'll size options to your target."
// instead of composing any card, so every corpus case expecting a sized suggestion
// (suggest-three-dinners and 7 others) failed deterministically regardless of model or latency.
// Fixed by calling the app's own write_target_revision RPC in seedRehearsal with this fixture.
describe("coach streak target revision fixture", () => {
  it("is complete enough for write_target_revision (target_macros_required, grams mode)", () => {
    const row = targetRevisionFixture("2026-10-03");
    expect(row.mode).toBe("grams");
    expect(row.effective_from).toBe("2026-10-03");
    // write_target_revision raises target_macros_required (22023) when either jsonb is absent.
    for (const macros of [row.training_macros, row.rest_macros]) {
      expect(macros.kcal).toBeGreaterThan(0);
      expect(macros.protein).toBeGreaterThan(0);
      expect(macros.carbs).toBeGreaterThan(0);
      expect(macros.fat).toBeGreaterThan(0);
    }
    // Consistent with the user_settings fixture seeded alongside it (weight, goal, training days).
    expect(row.input_weight_kg).toBe(60);
    expect(row.input_goal).toBe("recomp");
    expect(row.input_training_weekdays).toEqual([1, 3, 4, 5]);
  });
});
