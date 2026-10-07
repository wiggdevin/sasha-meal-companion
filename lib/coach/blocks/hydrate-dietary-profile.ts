/**
 * Phase 13 slice 4: builds the schema-typed `dietary_profile_proposal` block
 * (lib/coach/ui-blocks.ts) from a catalog summary. Pure: no I/O.
 */
import type { DietaryProfileProposalBlockV1 } from "@/lib/coach/ui-blocks";
import type { ProfileSummary } from "@/lib/policy/profiles/catalog-summary";
import {
  FOOD_PREFERENCE_PROFILE_ID, foodNamedFacet, type FoodPreferenceStrength,
} from "@/lib/policy/profiles/food-preference-rule";

const MAX_LINES = 3;

export function hydrateDietaryProfileProposal(
  id: string, profile: ProfileSummary,
): DietaryProfileProposalBlockV1 {
  return {
    kind: "dietary_profile_proposal", v: 1, id,
    profileId: profile.id,
    label: profile.label,
    do: profile.do.slice(0, MAX_LINES),
    dont: profile.dont.slice(0, MAX_LINES),
    requiresUserConfirmation: profile.requiresUserConfirmation,
    items: profile.items.map((item) => ({ ...item })),
  };
}

/**
 * Phase 13 slice 7 ("likes and dislikes"): the same confirm card for a stated like or dislike,
 * under the shared food-preference profile. Its one item is soft (`prefer`/`avoid`, no hard
 * basis): confirmed, it ranks and phrases suggestions and never blocks one.
 */
export function hydrateFoodPreferenceProposal(
  id: string, preference: { foodName: string; strength: FoodPreferenceStrength },
): DietaryProfileProposalBlockV1 {
  const food = preference.foodName.trim().slice(0, 40);
  const avoid = preference.strength === "avoid";
  return {
    kind: "dietary_profile_proposal", v: 1, id,
    profileId: FOOD_PREFERENCE_PROFILE_ID,
    label: avoid ? `Suggest less ${food}?` : `Suggest more ${food}?`,
    do: avoid ? [] : [`Favor ${food} when it fits.`],
    dont: avoid ? [`Suggest ${food} when something else fits.`] : [],
    // A soft like or dislike: one blanket tap, never an item-level medical confirmation.
    requiresUserConfirmation: false,
    items: [{ facet: foodNamedFacet(food), strength: preference.strength, hardBasis: null }],
  };
}
