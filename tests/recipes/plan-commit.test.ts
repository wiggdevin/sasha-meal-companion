import { describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { commitRecipeToPlan, type PlanCommitPort, type PlanRecipeRequest } from "@/lib/recipes/plan-commit";
import type { TargetRevision } from "@/lib/types";
import { recipe } from "./fixture";

const request: PlanRecipeRequest = {
  userId: "account-a", localDate: "2026-10-01", slotId: "dinner",
  recipeId: "stew", recipeRevisionId: "stew-v1", servingFraction: 1,
  acceptApproximate: false,
  expectedTargetRevision: 4, expectedRulesRevision: "rules-2",
  expectedPlanRevision: 7, idempotencyKey: "commit-1",
};
const target: TargetRevision = {
  id: "target-id", revision: 4, source: "derived", effectiveFrom: "2026-09-30",
  training: { kcal: 2100, protein: 130, carbs: 230, fat: 70 },
  rest: { kcal: 1900, protein: 130, carbs: 190, fat: 65 },
  pins: { trainingKcal: null, restKcal: null, proteinG: null },
  inputs: { effectiveDate: "2026-09-30", weightKg: 70, weightSource: "onboarding",
    trainingWeekdays: [], activity: "light", goal: "maintain", goalRateBpWeek: 0,
    formulaName: "mifflin" },
};

function ports(): PlanCommitPort {
  let saved: Awaited<ReturnType<PlanCommitPort["saveIfCurrent"]>> | null = null;
  return {
    findByIdempotencyKey: vi.fn(async () => saved),
    loadCurrent: vi.fn(async () => ({ recipe: recipe(), target,
      rulesRevision: "rules-2", profile: EMPTY_PROFILE, evidenceBySeq: {},
      explicitAvoidFoodRefIds: [], preferenceFlags: [],
      adaptationEvidence: { retainedFractionBySeq: { 1: 1, 2: 1 } },
    })),
    saveIfCurrent: vi.fn(async (selection) => { saved = selection; return selection; }),
  };
}

describe("plan commit boundary", () => {
  it("pins current target, rules, ingredient revisions and nutrients without logging food", async () => {
    const port = ports();
    const first = await commitRecipeToPlan(request, port);
    const retried = await commitRecipeToPlan(request, port);
    expect(retried).toBe(first);
    expect(port.saveIfCurrent).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ targetRevisionId: "target-id", targetRevision: 4,
      rulesRevision: "rules-2", recipeRevisionId: "stew-v1", planRevision: 8,
      exactFitAvailable: true });
    expect(first.ingredientSnapshot.map((line) => line.foodRevisionId)).toEqual([1, 2]);
  });

  it("rejects stale target, rules, and withdrawal before save", async () => {
    const port = ports();
    await expect(commitRecipeToPlan({ ...request, expectedTargetRevision: 3 }, port))
      .rejects.toThrow(/Target revision changed/);
    await expect(commitRecipeToPlan({ ...request, expectedRulesRevision: "old" }, port))
      .rejects.toThrow(/Food rules changed/);
    const load = port.loadCurrent as ReturnType<typeof vi.fn>;
    load.mockResolvedValueOnce({ recipe: recipe({ publicationState: "withdrawn",
      withdrawalReason: "evidence correction" }), target, rulesRevision: "rules-2",
      profile: EMPTY_PROFILE, evidenceBySeq: {}, explicitAvoidFoodRefIds: [],
      preferenceFlags: [], adaptationEvidence: { retainedFractionBySeq: { 1: 1, 2: 1 } } });
    await expect(commitRecipeToPlan(request, port)).rejects.toThrow(/withdrawn/);
    expect(port.saveIfCurrent).not.toHaveBeenCalled();
  });

  it("rejects a reused key with different intent", async () => {
    const port = ports();
    await commitRecipeToPlan(request, port);
    await expect(commitRecipeToPlan({ ...request, servingFraction: 1.5 }, port))
      .rejects.toThrow(/Idempotency key conflict/);
  });

  it("requires explicit acceptance when nutrient or retention evidence is incomplete", async () => {
    const port = ports();
    const load = port.loadCurrent as ReturnType<typeof vi.fn>;
    load.mockResolvedValue({ recipe: recipe(), target, rulesRevision: "rules-2",
      profile: EMPTY_PROFILE, evidenceBySeq: {}, explicitAvoidFoodRefIds: [],
      preferenceFlags: [], adaptationEvidence: { retainedFractionBySeq: {} } });
    await expect(commitRecipeToPlan(request, port)).rejects.toThrow(/approximate plan/);
    const saved = await commitRecipeToPlan({ ...request, acceptApproximate: true }, port);
    expect(saved.exactFitAvailable).toBe(false);
    expect(saved.nutritionSnapshot.kcal).toMatchObject({ value: 100, status: "estimated" });
  });
});
