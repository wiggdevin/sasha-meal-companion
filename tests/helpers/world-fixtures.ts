/**
 * Phase 18 W2b fixtures: one account's rows for the in-memory PostgREST double
 * (tests/helpers/occasion-fake-db.ts), with the two freshness clocks, and the evidence answer the
 * coach's evidence cache would give for its Eats (bread is the account's Favored food).
 */
import type { Row } from "@/tests/helpers/occasion-fake-db";

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export type WorldOptions = { world?: "open" | "closed"; conditions?: string[]; allergens?: string[];
  review?: boolean; flags?: string[]; foodWorldSetAt?: string | null };

export function worldTables(options: WorldOptions = {}): Record<string, Row[]> {
  const own = (id: string, name: string, per100: [number, number, number]) => ({ id, user_id: A, name,
    per_100g: { protein: per100[0], carbohydrate: per100[1], fat_total: per100[2] } });
  const foods = [own("bread", "Bread, whole-wheat", [13, 41, 3.4]),
    own("chicken", "Chicken breast, roasted", [31, 0, 3.6]), own("brown-rice", "Rice, brown", [2.6, 23, 0.9])];
  return {
    user_settings: [{ user_id: A, food_world: options.world ?? "closed",
      food_world_set_at: options.foodWorldSetAt ?? null,
      diet_prefs: { flags: options.flags ?? [] }, rev: 3 }],
    constraint_profiles: [{ user_id: A, rev: 2, conditions: options.conditions ?? [], notes: null,
      avoid_allergens: options.allergens ?? [], avoid_food_ref_ids: [], banned_categories: [], custom_rules: [],
      rule_review_required: false, rule_reviewed_at: null, condition_review_required: options.review ?? false }],
    user_dietary_profiles: [],
    user_food_prefs: [
      { user_id: A, food_ref_id: "ref-bread", status: "eats", role: "carb" },
      { user_id: A, food_ref_id: "ref-chicken", status: "eats", role: "protein" },
      { user_id: A, food_ref_id: "ref-brown-rice", status: "avoid", role: null },
    ],
    user_foods: foods,
    food_refs: foods.map((food) => ({ id: `ref-${food.id}`, kind: "user", catalog_food_id: null,
      user_food_id: food.id, user_foods: food })),
    catalog_food_revisions: [],
    food_membership_revisions: [{ user_id: A, name_norm: "salmon", status: "avoid", rev: 1 }],
    food_world_condition_confirmations: [],
    account_rules_clock: [{ user_id: A, rules_rev: 5 }],
    evidence_clock: [{ id: 1, evidence_rev: 2 }],
  };
}

/** The evidence cache's answer for the Eats above: names only, no tags (deterministic by name). */
export function eatsEvidence() {
  const facts = (foodName: string) => ({ allergenTags: null, allergenEvidence: {}, checkedAllergens: [],
    ingredientsText: null, foodName, policyCategories: [], noCook: null, onEatsList: true, onAvoidList: false,
    role: "protein", facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-10-01" } } });
  return { status: "ready" as const, preferenceFlags: [], byIdentity: {
    "ref:ref-bread": facts("Bread, whole-wheat"), "ref:ref-chicken": facts("Chicken breast, roasted") } };
}
