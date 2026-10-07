/**
 * Phase 13 slices 4 and 7 (§4, §9 R5): the confirm card a user's own message proposes — a stated
 * dietary need (catalog profile) first, else a stated like or dislike (a soft food preference).
 * Both propose and never apply: nothing is written until the user taps the card
 * (components/coach/blocks/dietary_profile.tsx). The caller runs this only on a turn whose text
 * already matched one of the cheap synchronous detectors, so the catalog is loaded on those rare
 * turns alone. The account's profile instances are the ones the turn already read
 * (lib/server/policy-profile.ts's `instances`) — never a second read here.
 */
import type { UiBlock } from "@/lib/coach/ui-blocks";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import { detectFoodPreference } from "@/lib/coach/food-preference-detect";
import { detectProfileCandidates } from "@/lib/coach/profile-detect";
import {
  FOOD_PREFERENCE_PROFILE_ID, foodNamedFacet,
} from "@/lib/policy/profiles/food-preference-rule";

/** Whether the message could propose anything at all — plain string checks, no I/O. */
export function mayPropose(text: string): boolean {
  return detectProfileCandidates(text).length > 0 || detectFoodPreference(text) !== null;
}

export async function proposalBlock(
  instances: readonly ProfileInstance[], text: string, newId: () => string,
): Promise<UiBlock | null> {
  const [{ proposeProfileFromMessage }, hydrate] = await Promise.all([
    import("@/lib/coach/profile-propose"),
    import("@/lib/coach/blocks/hydrate-dietary-profile"),
  ]);
  const proposal = detectProfileCandidates(text).length > 0
    ? proposeProfileFromMessage(text, instances) : null;
  const catalogCard = proposal ? hydrate.hydrateDietaryProfileProposal(newId(), proposal) : null;
  // A catalog profile whose items are still unfilled templates ("contains_ingredient:<name>",
  // the generic disliked-ingredients profile) says less than the food the user actually named.
  if (catalogCard && !catalogCard.items.some((item) => item.facet.includes("<"))) return catalogCard;
  const preference = detectFoodPreference(text);
  if (!preference) return catalogCard;
  // Never re-propose what the account already stated the same way.
  const facet = foodNamedFacet(preference.foodName);
  const stated = instances.find((i) => i.profileId === FOOD_PREFERENCE_PROFILE_ID)?.rules
    .some((rule) => rule.facet === facet && rule.strength === preference.strength);
  return stated ? null : hydrate.hydrateFoodPreferenceProposal(newId(), preference);
}
