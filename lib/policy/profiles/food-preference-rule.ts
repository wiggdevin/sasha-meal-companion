/**
 * Phase 13 slice 7 (§6 row 5, §4 map adoption): a like or dislike ("I hate cilantro", "I love
 * salmon") as a typed profile rule on one named food, using the slice 3/4 rule model
 * (lib/policy/profiles/types.ts) — never the hard-block path. Every rule this module builds
 * carries `hardBasis: null` and a strength of `prefer` or `avoid` only: `isActiveHardRule`
 * requires `strength === "never"`, so nothing built here can ever reach it, structurally, not by
 * convention. Pure: no I/O.
 */
import { ruleId, type ProfileSource, type RuleItem } from "@/lib/policy/profiles/types";

export type FoodPreferenceStrength = "prefer" | "avoid";

/** One profile instance per account for every food preference it has confirmed — a stable id
 *  distinct from any catalog profile id, so it can never collide with one. */
export const FOOD_PREFERENCE_PROFILE_ID = "food_preferences";

const FOOD_NAMED_PREFIX = "food_named:";

/** A food name, normalized to the exact form `food_named:<name>` matches against
 *  (lib/policy/profiles/hard-rules.ts) — lower-cased and whitespace-collapsed, never re-derived
 *  differently in two places. */
export function normalizeFoodName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function foodNamedFacet(name: string): string {
  return `${FOOD_NAMED_PREFIX}${normalizeFoodName(name)}`;
}

export type FoodPreferenceRuleInput = {
  foodName: string;
  strength: FoodPreferenceStrength;
  confirmedAt: string;
  source?: ProfileSource;
};

/** An unconfirmed rule item, ready for a confirm card. Applying it (writing `confirmation:
 *  "confirmed"`) is the caller's job — this module never writes. */
export function buildFoodPreferenceRule(input: FoodPreferenceRuleInput): RuleItem {
  const facet = foodNamedFacet(input.foodName);
  return {
    id: ruleId(FOOD_PREFERENCE_PROFILE_ID, facet),
    profileId: FOOD_PREFERENCE_PROFILE_ID,
    facet,
    strength: input.strength,
    hardBasis: null,
    evidenceStrength: "user_rule",
    confirmation: "unconfirmed",
    expiresAt: null,
  };
}
