/**
 * The one inventory of tables admission reads (Phase 18 D11, W2b re-plan): every insert, update or
 * delete of one of them moves an admission-input version, so a held admission can never outlive
 * its inputs. Account tables (each row names its owner in `user_id`) move that account's
 * `rulesVersion`; shared tables move the global `evidenceVersion`. Covering whole tables makes
 * every column count by construction; a read from a NEW table must be added here, and
 * tests/tenancy/admission-inputs.test.ts then fails until the migrations give it insert, update
 * and delete clock triggers.
 *
 * Readers: lib/server/candidate-foods.ts, lib/server/eligible-foods.ts, lib/server/policy-profile.ts,
 * lib/server/avoid-list.ts, lib/coach/suggest-policy.ts (evidence) and lib/foods/facets.ts.
 *
 * Pure data.
 */
export const ACCOUNT_ADMISSION_INPUTS = [
  "constraint_profiles", "user_food_prefs", "food_membership_revisions", "user_settings",
  "user_dietary_profiles", "food_world_condition_confirmations", "user_allergen_checks", "user_foods",
] as const;

export const SHARED_ADMISSION_INPUTS = [
  "food_allergen_evidence", "catalog_ingredients", "catalog_food_revisions", "catalog_food_nutrients",
  "catalog_foods", "catalog_portions", "food_refs", "food_facets",
] as const;

/** The trigger function that moves each kind of counter (migration 20261213090200). */
export const CLOCK_FUNCTIONS = { account: "rules_clock_bump", shared: "evidence_clock_bump" } as const;
