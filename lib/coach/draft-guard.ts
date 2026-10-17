/**
 * OD06 / W091: when a streamed draft reply may be shown at all.
 *
 * The saved reply goes through the full reply check (lib/server/reply-check.ts) before anyone
 * reads it as an answer; a draft arrives before that check can run. So a draft is held — never
 * shown, or cleared once shown — whenever the cheap, local reading below cannot rule out the very
 * thing the full check would replace:
 *
 * - the account has a rule this module cannot judge from text alone (a confirmed dietary-profile
 *   hard rule, a stated condition, a custom rule): no draft for the whole turn;
 * - the draft names an allergen the account avoids, by the same whole-word keywords the allergen
 *   scan uses (lib/policy/allergens.ts `textNames`);
 * - the draft names a food this turn already looked up that the policy blocks for this account.
 *
 * Holding is always safe: the person still gets the checked reply, a few seconds later. Pure.
 */

import { checkItem, type EvidenceByName } from "@/lib/coach/policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { textNames } from "@/lib/policy/allergens";

/** True when no draft may be shown this turn, whatever it says. */
export function draftsHeldFor(profile: ConstraintProfile): boolean {
  return (profile.profileRules?.items.length ?? 0) > 0
    || (profile.conditions ?? []).some((text) => text.trim() !== "")
    || (profile.custom_rules?.length ?? 0) > 0;
}

/** True when this draft names something the account must not be shown before the check. */
export function draftNamesBlocked(
  text: string, profile: ConstraintProfile, evidence: EvidenceByName,
): boolean {
  if (text.trim() === "") return false;
  if (profile.avoid_allergens.some((allergen) => allergen.trim() !== "" && textNames(allergen, text))) {
    return true;
  }
  const lower = text.toLowerCase();
  return Object.entries(evidence).some(([name, found]) => {
    const key = name.toLowerCase().trim();
    if (key === "" || !lower.includes(key)) return false;
    return checkItem({ ...found, name, grams: null }, profile, true).verdict === "blocked";
  });
}
