/**
 * W014 (audit 2026-10-10 A130, A134): a menu photo or uploaded menu, and an uploaded meal plan's
 * matched meal, are judged against the account's diet flags and confirmed profile hard rules, not
 * only its allergens, categories and Avoid list. A flag-only vegetarian, halal or vegan account
 * used to get pork belly as an unqualified pick and a ham sandwich placed as "allowed".
 */
import { describe, expect, it, vi } from "vitest";
import type { FoodHit } from "@/lib/coach/executors";
import { groundDocumentMeal } from "@/lib/plan/document-ground";
import type { MenuCandidate } from "@/lib/plan/photo-result";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { ruleId, type RuleItem } from "@/lib/policy/profiles/types";
import { menuVerdict, readMenuFlags, screenMenu, type MenuProfile } from "@/lib/server/plan-menu";
import { readyPlanEvidence } from "@/tests/helpers/plan-evidence";

const PROFILE: ConstraintProfile = {
  avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
};
const dish = (name: string, ingredients: string[]): MenuCandidate =>
  ({ name, kcal: 600, protein: 30, carbs: 40, fat: 15, tip: null, check: null, ingredients });
const PORK_BELLY = dish("Pork belly", ["pork belly", "soy sauce"]);
const RICE_BOWL = dish("Rice bowl", ["rice", "broccoli"]);

describe("menu screening reads the diet flags", () => {
  it("drops a dish a vegetarian, halal or no-pork flag blocks", () => {
    for (const flag of ["vegetarian", "halal", "no_pork"] as const) {
      expect(menuVerdict({ ...PROFILE, preferenceFlags: [flag] }, PORK_BELLY), flag)
        .toEqual({ blocked: true, check: null });
    }
    expect(menuVerdict({ ...PROFILE, preferenceFlags: [] }, PORK_BELLY)).toEqual({ blocked: false, check: null });
  });

  it("asks to check any other dish of a flagged account", () => {
    expect(menuVerdict({ ...PROFILE, preferenceFlags: ["vegetarian"] }, RICE_BOWL))
      .toEqual({ blocked: false, check: "Check it against your food rules" });
  });

  it("fails to a check when the flags could not be read", () => {
    expect(menuVerdict({ ...PROFILE, preferenceFlags: null }, RICE_BOWL))
      .toEqual({ blocked: false, check: "Check it against your food rules" });
  });

  it("asks to check under an active confirmed profile rule", () => {
    const rule: RuleItem = {
      id: ruleId("p", "pork"), profileId: "p", facet: "pork", strength: "never", hardBasis: "religious",
      evidenceStrength: null, confirmation: "confirmed", expiresAt: null,
    };
    const profile = { ...PROFILE, profileRules: { items: [rule], asOf: new Date("2026-10-10T00:00:00Z") } };
    expect(menuVerdict(profile as MenuProfile, RICE_BOWL).check).toBe("Check it against your food rules");
    expect(menuVerdict(profile as MenuProfile, PORK_BELLY).blocked).toBe(true);
  });

  it("screenMenu never offers the blocked dish", async () => {
    const searchFoods = vi.fn(async () => []);
    const picks = await screenMenu("u", [PORK_BELLY, RICE_BOWL], 600,
      { ...PROFILE, preferenceFlags: ["vegetarian"] }, searchFoods);
    expect(picks.map((pick) => [pick.name, pick.check]))
      .toEqual([["Rice bowl", "Check it against your food rules"]]);
  });
});

describe("readMenuFlags", () => {
  const admin = (result: { data: unknown; error: unknown }) => {
    const chain = { select: () => chain, eq: vi.fn(() => chain), maybeSingle: async () => result };
    return { from: vi.fn(() => chain), chain } as never;
  };

  it("reads the account's normalized flags by its own user id", async () => {
    const client = admin({ data: { diet_prefs: { flags: ["vegetarian", "nonsense"] } }, error: null });
    expect(await readMenuFlags(client, "u1")).toEqual(["vegetarian"]);
    expect((client as unknown as { chain: { eq: ReturnType<typeof vi.fn> } }).chain.eq)
      .toHaveBeenCalledWith("user_id", "u1");
    expect(await readMenuFlags(admin({ data: null, error: null }), "u1")).toEqual([]);
  });

  it("answers null, never [], when the flags cannot be read", async () => {
    expect(await readMenuFlags(admin({ data: null, error: { message: "down" } }), "u1")).toBeNull();
    expect(await readMenuFlags(admin({ data: { diet_prefs: { flags: "halal" } }, error: null }), "u1"))
      .toBeNull();
  });
});

describe("an uploaded meal plan's matched meal", () => {
  const hit = (name: string): FoodHit => ({
    foodRefId: `${name.replace(/\W/g, "")}-ref`, name, brand: null, prefStatus: null, kcalPer100g: 250,
    proteinPer100g: 15, carbsPer100g: 25, fatPer100g: 10, catalogFoodRevisionId: 9, allergenTags: [],
    category: [], portionGrams: null, portionLabel: null,
  });
  const meal = { name: "Lunch", time: null, foods: [
    { name: "ham sandwich", amount: "150 g" }, { name: "apple", amount: "100 g" },
  ] };
  const searchFoods = vi.fn(async (_u: string, query: string) => [hit(query)]);

  it("leaves out a food a vegan or halal flag blocks", async () => {
    for (const flag of ["vegan", "halal"] as const) {
      const evidence = readyPlanEvidence([flag], { "ham sandwich": { ingredientsText: "ham, bread" } });
      const out = await groundDocumentMeal("u", meal, PROFILE, { searchFoods, evidence });
      expect(out.items.map((item) => item.name), flag).not.toContain("ham sandwich");
      expect(out.left, flag).toContainEqual({ name: "ham sandwich", amount: "150 g", reason: "Off your food rules" });
    }
  });

  it("keeps it for an account with no flag", async () => {
    const out = await groundDocumentMeal("u", meal, PROFILE, { searchFoods, evidence: readyPlanEvidence() });
    expect(out.items.map((item) => item.name)).toEqual(["ham sandwich", "apple"]);
  });

  it("leaves out a dish nothing has judged human food yet, as suggestions do", async () => {
    const evidence = readyPlanEvidence([], { "ham sandwich": { facets: {} }, apple: { facets: {} } });
    const out = await groundDocumentMeal("u", meal, PROFILE, { searchFoods, evidence });
    expect(out.items.map((item) => item.name)).toEqual(["apple"]);
    expect(out.left).toContainEqual({ name: "ham sandwich", amount: "150 g",
      reason: "Couldn’t confirm it against your food rules" });
  });

  it("leaves everything out when the rules cannot be read", async () => {
    const evidence = vi.fn(async () => ({ status: "unavailable" as const, preferenceFlags: [], byIdentity: {} }));
    const out = await groundDocumentMeal("u", meal, PROFILE, { searchFoods, evidence });
    expect(out.items).toEqual([]);
    expect(out.left.map((food) => food.reason)).toEqual([
      "Couldn’t confirm it against your food rules", "Couldn’t confirm it against your food rules",
    ]);
  });
});
