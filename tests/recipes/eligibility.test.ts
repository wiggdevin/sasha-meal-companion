import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { ingredient, recipe } from "./fixture";

describe("recipe eligibility", () => {
  it("allows a complete zero-favorites recipe without fabricating personal rules", () => {
    expect(recipeEligibility(recipe(), { profile: EMPTY_PROFILE })).toEqual({ status: "eligible", reasons: [] });
  });

  it("blocks the whole recipe for an explicit Avoid, including a required spice", () => {
    const result = recipeEligibility(recipe(), { profile: EMPTY_PROFILE,
      explicitAvoidFoodRefIds: ["salt"] });
    expect(result.status).toBe("blocked");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "avoid_list", ingredientSeq: 2 }));
  });

  it("excludes relevant unknown allergen evidence under an active restriction", () => {
    const result = recipeEligibility(recipe(), { profile: {
      ...EMPTY_PROFILE, avoid_allergens: ["dairy"],
    } });
    expect(result.status).toBe("unknown");
    expect(result.reasons.some((entry) => entry.code === "policy_unknown")).toBe(true);
  });

  it("does not convert a bare absent bit into proven label clearance", () => {
    // 2026-10-02: "bean mix", not the shared fixture's plain "beans" — a recognized whole food's
    // own name now clears a non-intrinsic allergen on its own (owner decision, lib/policy/
    // whole-foods.ts), which would make this ingredient `eligible` by name alone before the test
    // ever reaches the bare-"absent"-bit question it exists to ask. "mix" keeps it a prepared
    // blend, outside that table, same as today.
    const candidate = recipe({ ingredients: [ingredient({ seq: 1, name: "bean mix",
      allergenEvidence: { dairy: "absent" } })] });
    const profile = { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] };
    expect(recipeEligibility(candidate, { profile }).status).toBe("unknown");
    expect(recipeEligibility(candidate, { profile, evidenceBySeq: { 1: {
      allergenEvidence: { dairy: { level: "not_listed", labelComplete: true } },
    } } }).status).toBe("eligible");
  });

  it("blocks known allergen and withdrawn revisions, never dropping the ingredient", () => {
    const candidate = recipe({ publicationState: "withdrawn", withdrawalReason: "rights",
      ingredients: [ingredient({ seq: 1, name: "milk", allergenEvidence: { dairy: "present" } })] });
    const result = recipeEligibility(candidate, { profile: { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] } });
    expect(result.status).toBe("blocked");
    expect(result.reasons.map((entry) => entry.code)).toContain("policy_block");
    expect(candidate.ingredients).toHaveLength(1);
  });

  it("keeps a present allergen block even when another evidence port says absent", () => {
    const candidate = recipe({ ingredients: [ingredient({ seq: 1, name: "milk",
      allergenEvidence: { dairy: "present" } })] });
    const result = recipeEligibility(candidate, {
      profile: { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] },
      evidenceBySeq: { 1: { allergenEvidence: {
        dairy: { level: "not_listed", labelComplete: true },
      }, allergenTags: [] } },
    });
    expect(result.status).toBe("blocked");
  });
});
