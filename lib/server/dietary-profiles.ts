/**
 * Phase 13 slice 4 (§4, §9 R5): the read/write path for `user_dietary_profiles`
 * (20261120090000_user_dietary_profiles.sql) — RLS-scoped `client` from `requireUser`, same
 * pattern as lib/server/constraints.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type { LegacyPreferenceFlag } from "@/lib/policy/profiles/legacy-flags";
import {
  legacyProfileIdsFor, profileInstancesForLegacyFlags,
} from "@/lib/policy/profiles/legacy-flags";
import { normalizePreferenceFlags } from "@/lib/profile/onboarding-state";
import type { ProfileInstance, RuleItem } from "@/lib/policy/profiles/types";

type Row = {
  profile_id: string; source: string; confirmed_at: string; rules: unknown; options: unknown;
  notes: string | null;
};

/**
 * Owner ruling (2026-10-02): a stored row's rules fail safe. `rules` not being an array used to
 * become `[]` silently — the same "unreadable reads as none" shape the missing-table fallback
 * below gave up — so a corrupt or partially-written row read as "this profile instance has no
 * hard rules" instead of surfacing that it could not be read.
 */
function instanceFromRow(row: Row): ProfileInstance {
  if (!Array.isArray(row.rules)) {
    throw new HttpError(500, "internal", "Could not read dietary profiles.");
  }
  return {
    profileId: row.profile_id,
    source: row.source as ProfileInstance["source"],
    confirmedAt: row.confirmed_at,
    rules: row.rules as readonly RuleItem[],
    options: (row.options !== null && typeof row.options === "object"
      ? row.options : {}) as Readonly<Record<string, boolean>>,
    ...(row.notes !== null ? { notes: row.notes } : {}),
  };
}

const SELECT = "profile_id, source, confirmed_at, rules, options, notes";

/** Every row this account has explicitly saved (onboarding or chat capture). A row here always
 *  wins over the legacy-flag synthesis (readAccountProfileInstances) for the same profile id.
 *
 *  Owner ruling (2026-10-02): a missing `user_dietary_profiles` relation used to read as "no
 *  stored profiles," on the theory that 20261120090000_user_dietary_profiles.sql might not be
 *  applied yet. It has shipped; a missing-table error now almost certainly means something else
 *  is wrong, and treating it as "this account has no hard rules" would silently clear a
 *  religious/user_rule/user_confirmed_safety rule it actually has. Every error throws now, the
 *  same as lib/server/recipe-candidates.ts already does for this table. */
export async function readStoredProfileInstances(
  client: SupabaseClient, userId: string,
): Promise<ProfileInstance[]> {
  const { data, error } = await client.from("user_dietary_profiles")
    .select(SELECT).eq("user_id", userId);
  if (error) throw new HttpError(500, "internal", "Could not read dietary profiles.");
  return ((data ?? []) as Row[]).map(instanceFromRow);
}

/** A synthesized legacy instance's date when the settings row carries none: fixed, never "now". */
const LEGACY_EPOCH = "1970-01-01T00:00:00.000Z";

type LegacySettings = { flags: LegacyPreferenceFlag[]; since: string };

/** The account's legacy flags, and the settings row's own stored time to date them from. */
async function readLegacySettings(client: SupabaseClient, userId: string): Promise<LegacySettings> {
  const settings = await client.from("user_settings")
    .select("diet_prefs, changed_at, onboarded_at").eq("user_id", userId).maybeSingle();
  if (settings.error) throw new HttpError(500, "internal", "Could not read dietary profiles.");
  const row = settings.data as { diet_prefs?: { flags?: unknown } | null;
    changed_at?: string | null; onboarded_at?: string | null } | null;
  const rawFlags = row?.diet_prefs?.flags;
  const flags = normalizePreferenceFlags(Array.isArray(rawFlags)
    ? rawFlags.filter((flag): flag is string => typeof flag === "string") : []);
  return {
    flags: flags as LegacyPreferenceFlag[],
    since: row?.changed_at ?? row?.onboarded_at ?? LEGACY_EPOCH,
  };
}

/**
 * The account's full confirmed-profile set: every explicitly-saved row, plus a synthesized
 * instance for any of the 12 legacy flags (`user_settings.diet_prefs.flags`) this account has not
 * yet migrated into its own row — the migration's own documented approach
 * (20261120090000_user_dietary_profiles.sql), so a flag set before this table existed keeps
 * restricting exactly as it always did. A synthesized instance is dated from the settings row's
 * own stored time, so two reads of the same state return the same instances (deepseek FIX).
 */
export async function readAccountProfileInstances(
  client: SupabaseClient, userId: string,
): Promise<ProfileInstance[]> {
  return (await readAccountProfileSets(client, userId)).all;
}

/** The same one parallel read, split: `stored` is the explicitly-saved rows alone, `all` adds the
 *  legacy-flag synthesis (readAccountProfileInstances) — for a caller that needs both views. */
export async function readAccountProfileSets(
  client: SupabaseClient, userId: string,
): Promise<{ stored: ProfileInstance[]; all: ProfileInstance[] }> {
  const [stored, legacy] = await Promise.all([
    readStoredProfileInstances(client, userId), readLegacySettings(client, userId),
  ]);
  const storedIds = new Set(stored.map((instance) => instance.profileId));
  const synthesized = profileInstancesForLegacyFlags(legacy.flags, legacy.since)
    .filter((instance) => !storedIds.has(instance.profileId));
  return { stored, all: [...stored, ...synthesized] };
}

/** The profile ids this account's set legacy flags keep active: removing one of these rows does
 *  not remove the rule — only turning the flag off in the preferences does. */
export async function legacyBackedProfileIds(
  client: SupabaseClient, userId: string,
): Promise<Set<string>> {
  return legacyProfileIdsFor((await readLegacySettings(client, userId)).flags);
}

export type PutProfileInstanceInput = {
  profileId: string; source: ProfileInstance["source"]; confirmedAt: string;
  rules: readonly RuleItem[]; options?: Readonly<Record<string, boolean>>; notes?: string;
};

const MERGE_ATTEMPTS = 3;
const UNIQUE_VIOLATION = "23505";

/**
 * Writes one profile row as a merge over what is stored, never a blind replace (sol BLOCK, p13-s4
 * review): `build` gets the stored instance (or null) and returns the full next state, and the
 * write lands only while the row is still at the `rev` it was built from. Two confirm taps racing
 * each other therefore cannot drop one another — the loser re-reads and merges again — and after
 * MERGE_ATTEMPTS lost races the write fails (409) rather than overwriting.
 */
export async function mergeAccountProfileInstance(
  client: SupabaseClient, userId: string, profileId: string,
  build: (stored: ProfileInstance | null) => PutProfileInstanceInput,
): Promise<ProfileInstance> {
  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const current = await client.from("user_dietary_profiles").select(`${SELECT}, rev`)
      .eq("user_id", userId).eq("profile_id", profileId).maybeSingle();
    if (current.error) throw new HttpError(500, "internal", "Could not read the profile.");
    const stored = current.data as (Row & { rev: number }) | null;
    const input = build(stored ? instanceFromRow(stored) : null);
    const row = {
      user_id: userId, profile_id: profileId, source: input.source,
      confirmed_at: input.confirmedAt, rules: input.rules, options: input.options ?? {},
      notes: input.notes ?? null, updated_at: new Date().toISOString(),
    };
    const written = stored === null
      ? await client.from("user_dietary_profiles").insert({ ...row, rev: 1 })
        .select(SELECT).maybeSingle()
      : await client.from("user_dietary_profiles").update({ ...row, rev: stored.rev + 1 })
        .eq("user_id", userId).eq("profile_id", profileId).eq("rev", stored.rev)
        .select(SELECT).maybeSingle();
    if (written.error && (written.error as { code?: string }).code === UNIQUE_VIOLATION) continue;
    if (written.error) throw new HttpError(500, "internal", "Could not save the profile.");
    if (written.data === null) continue; // another write moved `rev` first: re-read and re-merge
    return instanceFromRow(written.data as Row);
  }
  throw new HttpError(409, "conflict", "The profile changed while saving. Try again.");
}

export async function deleteAccountProfileInstance(
  client: SupabaseClient, userId: string, profileId: string,
): Promise<void> {
  const { error } = await client.from("user_dietary_profiles")
    .delete().eq("user_id", userId).eq("profile_id", profileId);
  if (error) throw new HttpError(500, "internal", "Could not remove the profile.");
}
