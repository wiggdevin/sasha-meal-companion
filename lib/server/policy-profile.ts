/**
 * Phase 13 slice 4 (§4, §9 R5): the constraint profile a coach turn judges food against — the
 * `constraint_profiles` row plus this account's confirmed dietary-profile hard rules — read in ONE
 * parallel round (never a sequential wait) and then handed to every policy call site the turn
 * reaches (suggestions, composed meals, logs, recipes, the reply check).
 *
 * Only explicitly stored `user_dietary_profiles` rows feed `profileRules`. The 12 legacy flags
 * already reach `evaluatePolicy` as `preferenceFlags` (lib/coach/suggest-policy.ts), so their
 * synthesized instances (lib/server/dietary-profiles.ts) are not added a second time here.
 *
 * `instances` is the account's full set (stored rows plus legacy-flag synthesis) from the same
 * read, so the rest of the turn — the live reply check's rules and the confirm-card proposal
 * (Phase 13 slice 7) — reuses it instead of reading the profile rows again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { activeHardRulesFor } from "@/lib/policy/profiles/account-rules";
import type { ProfileRuleSet } from "@/lib/policy/profiles/hard-rules";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import { getProfile, type StoredProfile } from "@/lib/server/constraints";
import { readAccountProfileSets } from "@/lib/server/dietary-profiles";

export type PolicyProfile = StoredProfile & { profileRules: ProfileRuleSet };

export async function readPolicyProfile(
  client: SupabaseClient, userId: string, asOf: Date,
): Promise<{ profile: PolicyProfile; rev: number; instances: ProfileInstance[] }> {
  const [{ profile, rev }, { stored, all }] = await Promise.all([
    getProfile(client, userId), readAccountProfileSets(client, userId),
  ]);
  return {
    profile: { ...profile, profileRules: activeHardRulesFor(stored, asOf) }, rev, instances: all,
  };
}
