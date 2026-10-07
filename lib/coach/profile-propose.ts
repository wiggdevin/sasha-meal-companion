/**
 * Phase 13 slice 4 (§4, §6 row 4): the pure decision of WHETHER a turn proposes a profile — never
 * whether it applies one (nothing here writes; app/api/profile/instances/route.ts is the only
 * write path). Detection is deterministic (lib/coach/profile-detect.ts); the only judgment this
 * module adds is not re-proposing a profile the account already has a row for, confirmed or not —
 * a stored row (even a partly-unconfirmed one) means onboarding or an earlier turn already
 * surfaced it, and the account's own picker is where they manage it from here.
 */
import { detectProfileCandidates } from "@/lib/coach/profile-detect";
import {
  isOfferedProfile, profileSummary, type ProfileSummary,
} from "@/lib/policy/profiles/catalog-summary";
import type { ProfileInstance } from "@/lib/policy/profiles/types";

/** The first candidate the message names that the account has no stored row for, or null. At
 *  most one per turn (the block system renders a single block, same as every other tool). */
export function proposeProfileFromMessage(
  text: string,
  existingInstances: readonly Pick<ProfileInstance, "profileId">[],
): ProfileSummary | null {
  const known = new Set(existingInstances.map((instance) => instance.profileId));
  for (const id of detectProfileCandidates(text)) {
    if (known.has(id)) continue;
    const summary = profileSummary(id);
    // A gated condition pack (CONDITION_PACKS_ENABLED off) is never proposed (§4).
    if (summary && isOfferedProfile(summary)) return summary;
  }
  return null;
}
