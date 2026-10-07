/**
 * The `write_target_revision` RPC payload (supabase/migrations/20261023091000) for the streak
 * fixture account: grams mode, training_macros/rest_macros both present (the function raises
 * target_macros_required without them), consistent with the moderate/recomp user_settings the
 * harness seeds alongside it. Exported so a regression test can check the contract without a
 * live branch.
 *
 * Why this exists: the target-authority boundary (2026-09-22) means `compose_meal`/
 * `suggest_options` never invent numbers from `user_settings` alone. Without an effective
 * `target_profiles` revision the coach answers "Your targets aren't set yet" instead of sizing
 * any card, regardless of model or latency — so every suggestion-sizing corpus case needs this
 * seeded through the same RPC the app itself writes through (also used by
 * tests/coach/suggest-new-account.test.ts).
 */
export function targetRevisionFixture(effectiveFrom: string): {
  effective_from: string; target_source: string; mode: "grams";
  training_macros: { kcal: number; protein: number; carbs: number; fat: number };
  rest_macros: { kcal: number; protein: number; carbs: number; fat: number };
  input_weight_kg: number; input_weight_source: string; input_training_weekdays: number[];
  input_activity_level: string; input_goal: string; formula_name: string;
  kcal_min: number; protein_g_min: number; fat_g_min: number; carb_g_min: number;
} {
  return {
    effective_from: effectiveFrom, target_source: "derived", mode: "grams",
    training_macros: { kcal: 2100, protein: 130, carbs: 240, fat: 69 },
    rest_macros: { kcal: 1893, protein: 130, carbs: 165, fat: 69 },
    input_weight_kg: 60, input_weight_source: "onboarding",
    input_training_weekdays: [1, 3, 4, 5], input_activity_level: "moderate",
    input_goal: "recomp", formula_name: "coach-streak-fixture",
    kcal_min: 1650, protein_g_min: 120, fat_g_min: 50, carb_g_min: 100,
  };
}
