// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { mergeEligibility, readStoredEligibility } from "@/components/Onboarding/v2/stored-eligibility";
import { emptyPlanAnswers, planCardNotes } from "@/components/Onboarding/v2/plan-answers";
import { SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";

const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], notes: null };

beforeEach(() => { bindAccount("11111111-1111-4111-8111-111111111111"); });
afterEach(() => { unbindAccount(); });

describe("the account's stored pace holds (final Sol review BLOCK)", () => {
  it("reads a stored condition the safety round did not repeat as a hold", async () => {
    const stored = await readStoredEligibility({
      constraints: vi.fn(async () => ({ profile: { ...rules, conditions: [SAFETY_CONDITION_TEXT.pregnant] }, rev: 3 })),
      instances: vi.fn(async () => ({ instances: [], catalog: [], legacyProfileIds: [] })),
    } as never);
    expect(stored?.holds).toEqual(["pregnancy"]);
    // "No, none of these" this round: the merged eligibility still holds the pace.
    expect(mergeEligibility({ holds: [], minor: false }, stored)).toEqual({ holds: ["pregnancy"], minor: false });
  });

  it("answers null when a read fails, leaving the round's own answers in force", async () => {
    const stored = await readStoredEligibility({
      constraints: vi.fn(async () => null),
      instances: vi.fn(async () => ({ instances: [], catalog: [], legacyProfileIds: [] })),
    } as never);
    expect(stored).toBeNull();
    expect(mergeEligibility({ holds: ["kidney"], minor: false }, stored)).toEqual({ holds: ["kidney"], minor: false });
  });

  it("the plan card names a stored hold even when this round's taps name none", () => {
    const notes = planCardNotes({ goal: "lose_fat", answers: emptyPlanAnswers(), pace: { kind: "held", goal: "lose_fat" },
      mealCount: 3, firstMealTime: "08:00", eligibility: { holds: ["kidney"], minor: false } });
    expect(notes.map((note) => note.id)).toEqual(expect.arrayContaining(["held", "kidney"]));
  });
});
