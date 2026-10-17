/**
 * The account's own formula numbers, read from `user_settings`: the BMR and the activity-scaled
 * TDEE that lib/profile/energy.ts derives for onboarding. Two callers:
 *
 * - `profileSeedFor` seeds the expenditure engine (lib/server/expenditure.ts): the first prior
 *   before any estimate is stored, and the BMR the absolute clamp is measured against. Until
 *   2026-09-22 both were constants fitted to one early account and applied to every account
 *   (ruling 2026-09-22).
 * - `profileTdeeFor` is the display-only burn-in headline and the coach status payload.
 *
 * lib/tdee.ts (the Body screen's own display estimate) stays off this path; lib/tdee.test.ts
 * guards that. The goal is deliberately `maintain`: expenditure is what the person burns, and the
 * deficit or surplus belongs to the target, never to the estimate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { bmr, isoDay, tdee, type EnergyProfile } from "@/lib/profile/energy";
import { BODY_FAT_SOURCES, type BodyFatSource } from "@/lib/types";
import { activeProfile } from "@/lib/server/targets";
import { targetSeedFromProfile } from "@/lib/targets/revision";

const ACTIVITY_LEVELS = new Set(["sedentary", "light", "moderate", "active", "very_active"]);

export type ProfileSeed = { tdeeKcal: number; bmrKcal: number };
export type SeedSource = "revision" | "live_profile";
export type EngineSeed = ProfileSeed & { source: SeedSource };

/**
 * The seed the engine learns from (TDEE step E1): the formula start frozen on the target revision
 * active on `asOf`, so a later profile edit does not silently change what old estimates meant.
 * A revision written before E1 has no frozen seed; then the live profile is the seed, as before.
 */
export async function seedFor(
  client: SupabaseClient, userId: string, asOf: unknown,
): Promise<EngineSeed | null> {
  const day = /^\d{4}-\d{2}-\d{2}/.test(String(asOf)) ? String(asOf).slice(0, 10) : undefined;
  const active = await activeProfile(client, userId, day);
  const frozen = active ? targetSeedFromProfile(active) : null;
  if (frozen) {
    return { tdeeKcal: frozen.initialTdeeKcal, bmrKcal: frozen.bmrKcal, source: "revision" };
  }
  const live = await profileSeedFor(client, userId, asOf);
  return live ? { ...live, source: "live_profile" } : null;
}

/** `null` when the profile is incomplete: there is no seed, and no caller may invent one. */
export async function profileSeedFor(
  client: SupabaseClient, userId: string, asOf: unknown,
): Promise<ProfileSeed | null> {
  const { data, error } = await client.from("user_settings")
    .select(
      "sex, birth_year, height_cm, weight_kg, body_fat_pct, body_fat_source, body_fat_measured_on, activity_level")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  // A zero weight or height passes Number.isFinite and would make the BMR clamp [0, 0]; a body
  // fat outside [0, 100) is not a measurement. Any of these is an incomplete profile: no seed.
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  const bodyFat = data?.body_fat_pct == null ? null : Number(data.body_fat_pct);
  if (!data
    || (data.sex !== "female" && data.sex !== "male" && data.sex !== "unspecified")
    || !Number.isFinite(Number(data.birth_year)) || Number(data.birth_year) < 1900
    || !positive(data.height_cm)
    || !positive(data.weight_kg)
    || (bodyFat !== null && !(bodyFat >= 0 && bodyFat < 100))
    || !ACTIVITY_LEVELS.has(String(data.activity_level))) return null;
  const profile: EnergyProfile = {
    sex: data.sex,
    birthYear: Number(data.birth_year),
    heightCm: Number(data.height_cm),
    weightKg: Number(data.weight_kg),
    bodyFatPct: bodyFat,
    // Unknown values read as unverified, which selects Mifflin-St Jeor (step C).
    bodyFatSource: (BODY_FAT_SOURCES as readonly string[]).includes(String(data.body_fat_source))
      ? data.body_fat_source as BodyFatSource : null,
    bodyFatMeasuredOn: isoDay(data.body_fat_measured_on),
    activityLevel: data.activity_level as EnergyProfile["activityLevel"],
    goal: "maintain",
    goalRateBpWeek: 0,
  };
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(asOf))
    ? new Date(`${String(asOf).slice(0, 10)}T12:00:00Z`)
    : new Date();
  // Same whole-kcal rule as lib/profile/energy.ts `deriveTargets` (step E8, one energy number):
  // squash IEEE noise first, so 1,337.5 × 1.4 is the ruling's 1,873 here too, not 1,872.
  const whole = (value: number) => Math.round(Number(value.toFixed(6)));
  return { tdeeKcal: whole(tdee(profile, date)), bmrKcal: whole(bmr(profile, date)) };
}

export async function profileTdeeFor(
  client: SupabaseClient, userId: string, asOf: unknown,
): Promise<number | null> {
  const seed = await seedFor(client, userId, asOf);
  return seed ? seed.tdeeKcal : null;
}
