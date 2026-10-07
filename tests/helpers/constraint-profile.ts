/**
 * The constraint profile the policy, coach and migration tests were written against.
 *
 * It used to be `DEFAULT_PROFILE` in lib/policy/constraints.ts — one account's clinical rules,
 * applied in memory to every account that had no `constraint_profiles` row. D1 §6.1 removed that
 * constant (PRD R2: no restriction lives in code). The tests that need "a profile which avoids
 * things" keep the same values here, as an explicit fixture, so their assertions still mean
 * exactly what they meant before. Nothing the app ships reads this file.
 */
import type { ConstraintProfile } from "@/lib/policy/constraints";

export const TEST_PROFILE: ConstraintProfile = {
  avoid_allergens: ["gluten", "dairy", "apple"],
  avoid_food_ref_ids: [],
  banned_categories: [
    "raw_cruciferous", "raw_leafy_greens", "onion_garlic", "beans", "simple_sugars",
  ],
};
