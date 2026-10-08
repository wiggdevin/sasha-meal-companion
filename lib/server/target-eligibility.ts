/**
 * The server's read of an account's pace holds (lib/profile/rate-eligibility.ts; question set
 * §8b G1–G3). Every target write path reads this itself — the targets route, the profile
 * recompute, a pinned (authored) revision and the weekly proposal — so a Settings edit, a coach
 * `update_profile` or an old phone can never set a loss or gain pace for a held account.
 *
 * Two owner-scoped reads (explicit `user_id`): the constraint row's `conditions` and the
 * account's stored dietary-profile ids and sources. A failed read throws: a target is never
 * written on the guess that the account has no hold.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { targetEligibility, type TargetEligibility } from "@/lib/profile/rate-eligibility";

type ConditionsRow = { conditions: unknown } | null;
type ProfileRow = { profile_id: unknown; source: unknown };

type SettingsRow = { birth_year: unknown } | null;

/**
 * `onDate` (YYYY-MM-DD) also reads the stored birth year, so a write that carries no birth year
 * of its own (a pinned revision) still builds nothing for an account under 18 on that date.
 */
export async function readTargetEligibility(
  client: SupabaseClient, userId: string, onDate?: string,
): Promise<TargetEligibility> {
  const [constraints, profiles, settings] = await Promise.all([
    client.from("constraint_profiles").select("conditions").eq("user_id", userId).maybeSingle(),
    client.from("user_dietary_profiles").select("profile_id, source").eq("user_id", userId),
    onDate ? client.from("user_settings").select("birth_year").eq("user_id", userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (constraints.error || profiles.error || settings.error) {
    throw new HttpError(503, "eligibility_unavailable", "Could not read the account's health answers.");
  }
  const raw = (constraints.data as ConditionsRow)?.conditions;
  const conditions = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string")
    : [];
  const rows = Array.isArray(profiles.data) ? profiles.data as ProfileRow[] : [];
  const birthYear = (settings.data as SettingsRow)?.birth_year;
  return targetEligibility({
    conditions,
    ...(onDate ? { onDate, birthYear: typeof birthYear === "number" ? birthYear : null } : {}),
    profiles: rows.filter((row) => typeof row.profile_id === "string").map((row) => ({
      profileId: row.profile_id as string,
      source: typeof row.source === "string" ? row.source : null,
    })),
  });
}
