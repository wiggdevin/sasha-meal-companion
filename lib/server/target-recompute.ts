/**
 * Server-side target recompute from the account's own `user_settings` row.
 *
 * Profile edits (the /body screen, Settings, coach profile changes) reach the server as
 * `user_settings` sync ops. Before this module, the phone was the only thing that re-derived the
 * target after such an edit, so a lost or raced client post left the active revision stale
 * (#330). Here the server derives from its own authoritative row, in one place:
 *
 * - The inputs are read from the database, never from the op payload, so an older request can
 *   never derive from a newer request's payload.
 * - After a write, the run re-reads settings and the active revision. If another save moved the
 *   row, it derives again from the newer row, so the last writer leaves the revision that matches
 *   the current row.
 * - Nothing is written when the active revision already matches, so a retry is a no-op.
 * - Adaptive and proposal revisions (another `formula_name`) are authoritative and left alone, and
 *   an account that has not finished onboarding is skipped: onboarding writes its own revision.
 * - The write is conditional (`write_target_revision_if_active`): it lands only while the
 *   revision this run planned from is still active, so a weigh-in, pin, proposal or another
 *   recompute that committed meanwhile is never buried; on conflict the run re-plans.
 * - It re-derives from profile fields only. Weight and pins stay what the active revision says:
 *   a weigh-in revision keeps its weight (the weigh-in path owns weight changes and retries its
 *   own post), an onboarding revision uses the profile weight, and pins are the revision's. When
 *   the settings row carries pins that differ from the revision's, the run cannot tell which is
 *   newer and skips (`pins_differ`), leaving the phone's own target post in charge.
 * - A revision dated after the run's date (a phone clock ahead of the account zone) is left alone:
 *   a write dated today could not supersede it, so the run skips instead of writing a dead row.
 * - The account's pace holds (lib/server/target-eligibility.ts) are read on every plan: a held
 *   account derives at a 0 pace, and an account under 18 is skipped (`adult_only`). Under a hold,
 *   the revision in force today and every scheduled later revision that carries a pace (adaptive
 *   and proposal revisions too) are superseded on their own dates by 0-pace derivations, so no
 *   date after the hold has a pace.
 * - The run's date is the account's stored zone when one is on file (t24b, owner ruling
 *   2026-10-08: account-zone precedence), else the phone's own day when the batch carries one,
 *   else the request's zone, and UTC as the logged last resort (lib/server/account-day.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TARGET_FORMULA_NAME, deriveTargetRevision, targetSourceFor,
  type DeriveTargetRevisionInput,
} from "@/lib/profile/derive";
import { isProfileComplete } from "@/lib/profile/energy";
import type { TargetProfile } from "@/lib/api-types";
import type { Macros, Settings, TargetRevision } from "@/lib/types";
import { settingsProfileFromRow, type UserSettingsProfileRow } from "@/lib/sync/user-settings";
import { activeProfile, writeDerivedTargets, writeDerivedTargetsIfActive } from "@/lib/server/targets";
import { resolveAccountDay } from "@/lib/server/account-day";
import { fetchAllRows } from "@/lib/server/paged-read";
import { readTargetEligibility } from "@/lib/server/target-eligibility";
import { isMinorOn, paceAllowed } from "@/lib/profile/rate-eligibility";

const SETTINGS_COLUMNS = [
  "rev", "time_zone", "height_cm", "height_unit", "weight_unit", "birth_year", "sex",
  "body_fat_pct", "body_fat_source", "body_fat_measured_on", "weight_kg", "activity_level", "goal",
  "goal_rate_bp_week", "training_weekdays", "onboarded_at", "meals_per_day",
  "training_kcal", "rest_kcal", "protein_g",
].join(",");

/** A write round plus its verification round, with room for two concurrent changes. */
const MAX_ROUNDS = 4;

type SettingsRow = UserSettingsProfileRow & {
  rev: number | null;
  training_kcal: number | null; rest_kcal: number | null; protein_g: number | string | null;
};

export type RecomputeSkip =
  | "no_settings" | "not_onboarded" | "incomplete_profile" | "authoritative_formula"
  | "future_revision" | "pins_differ" | "adult_only";

type Derived = ReturnType<typeof deriveTargetRevision>;

export type RecomputeOutcome =
  | { status: "skipped"; reason: RecomputeSkip; active: TargetProfile | null }
  | { status: "unchanged"; active: TargetProfile; expected: Derived }
  | { status: "would_write"; active: TargetProfile | null; expected: Derived }
  /** `active` is the revision active after the write. */
  | { status: "written"; active: TargetProfile | null; revision: TargetRevision; rounds: number }
  /** Settings or the active revision kept moving for every round; the next settings op retries. */
  | { status: "unsettled"; active: TargetProfile | null; rounds: number };

export type RecomputeOptions = {
  /** Local calendar date the revision takes effect; defaults to the account's day (below). */
  today?: string;
  /** The phone's own day, sent with the batch (t24b): used only when the account has no usable
   *  stored zone — the account's zone wins over a travelling phone's own clock. */
  clientDay?: string | null;
  /** The zone the request carries; used only when the account has no stored zone. */
  requestZone?: string | null;
  /** Report what would be written and write nothing. */
  dryRun?: boolean;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** PostgREST returns numeric columns as numbers or strings depending on the path. */
function normalizeRow(raw: Record<string, unknown>): SettingsRow {
  const row = { ...raw } as SettingsRow & Record<string, unknown>;
  for (const key of ["height_cm", "body_fat_pct", "weight_kg"] as const) row[key] = num(raw[key]);
  row.training_kcal = num(raw.training_kcal);
  row.rest_kcal = num(raw.rest_kcal);
  row.protein_g = num(raw.protein_g);
  row.rev = num(raw.rev);
  row.goal_rate_bp_week = num(raw.goal_rate_bp_week);
  return row;
}

/** The server's own Settings view of the row. The display-only fields are fixed exactly as the
 *  /api/targets route fixes them; `tests/server/target-recompute.test.ts` proves derivation does
 *  not read them. */
export function settingsFromRow(
  raw: SettingsRow | Record<string, unknown>,
  pins: { trainingKcal: number | null; restKcal: number | null; proteinG: number | null } | null = null,
): Settings {
  const row = normalizeRow(raw as Record<string, unknown>);
  return {
    ...settingsProfileFromRow(row),
    trainingKcal: pins ? pins.trainingKcal : row.training_kcal,
    restKcal: pins ? pins.restKcal : row.rest_kcal,
    proteinG: pins ? pins.proteinG : num(row.protein_g),
    proteinLocked: true,
    slotTimes: {},
    shiftMinutes: 0,
    changedAt: null,
  } as Settings;
}

/** The account's day from its stored zone (lib/server/account-day.ts: then UTC as the logged
 *  last resort). */
export function localDate(timeZone: string | null | undefined, now: Date = new Date()): string {
  return resolveAccountDay({ purpose: "localDate", storedZone: timeZone, now }).date;
}

async function readSettings(client: SupabaseClient, userId: string): Promise<SettingsRow | null> {
  const { data, error } = await client.from("user_settings").select(SETTINGS_COLUMNS)
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? normalizeRow(data as unknown as Record<string, unknown>) : null;
}

/** The weigh-in weight a recompute keeps: the active revision's, when it came from a weigh-in.
 *  Null means the profile weight (an onboarding revision, or no revision yet). */
export function weighInKgToKeep(
  active: Pick<TargetProfile, "input_weight_source" | "input_weight_kg"> | null,
): number | null {
  return active?.input_weight_source === "weigh-in" ? num(active.input_weight_kg) : null;
}

type Pins = { trainingKcal: number | null; restKcal: number | null; proteinG: number | null };

function samePins(left: Pins, right: Pins): boolean {
  return left.trainingKcal === right.trainingKcal && left.restKcal === right.restKcal
    && left.proteinG === right.proteinG;
}

/** The revision that takes effect on each date after `after` (highest `rev` per date), in date
 *  order: a lower `rev` on the same date never comes into force. Every scheduled row is read,
 *  paged past the API's 1,000-row cap (lib/server/paged-read.ts) and failing whole, so a paced
 *  revision can never sit beyond the read and take effect after a new hold. */
async function futureRevisions(
  client: SupabaseClient, userId: string, after: string,
): Promise<TargetProfile[]> {
  const data = await fetchAllRows<TargetProfile>((from, to) => client.from("target_profiles")
    .select("*").eq("user_id", userId).gt("effective_from", after)
    .order("effective_from", { ascending: true }).order("rev", { ascending: false })
    .order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<{
      data: TargetProfile[] | null; error: { message: string } | null }>);
  const byDate = new Map<string, TargetProfile>();
  for (const row of data) {
    const kept = byDate.get(row.effective_from);
    if (!kept || row.rev > kept.rev) byDate.set(row.effective_from, row);
  }
  return [...byDate.values()].sort((a, b) => a.effective_from < b.effective_from ? -1 : 1);
}

function hasPace(profile: Pick<TargetProfile, "goal_rate_bp_week"> | null): boolean {
  return Number(profile?.goal_rate_bp_week ?? 0) !== 0;
}

function pinsOf(profile: TargetProfile): Pins {
  return { trainingKcal: num(profile.pin_training_kcal), restKcal: num(profile.pin_rest_kcal),
    proteinG: num(profile.pin_protein_g) };
}

function sameMacros(left: Macros | null | undefined, right: Macros): boolean {
  return !!left && (["kcal", "protein", "carbs", "fat"] as const)
    .every((key) => Number(left[key]) === Number(right[key]));
}

function sameNullableNumber(left: unknown, right: number | null): boolean {
  return num(left) === right;
}

function sameWeekdays(left: number[] | null | undefined, right: readonly number[]): boolean {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b))
    === JSON.stringify([...right].sort((a, b) => a - b));
}

/** True when the stored revision already says what a fresh derivation would write. */
export function revisionMatches(active: TargetProfile, expected: Derived): boolean {
  return (active.formula_name ?? null) === expected.inputs.formulaName
    && (active.target_source ?? null) === expected.source
    && sameMacros(active.training_macros, expected.training)
    && sameMacros(active.rest_macros, expected.rest)
    && sameNullableNumber(active.pin_training_kcal, expected.pins.trainingKcal)
    && sameNullableNumber(active.pin_rest_kcal, expected.pins.restKcal)
    && sameNullableNumber(active.pin_protein_g, expected.pins.proteinG)
    && Math.abs(Number(active.input_weight_kg) - expected.inputs.weightKg) < 0.001
    && (active.input_weight_source ?? null) === expected.inputs.weightSource
    && sameWeekdays(active.input_training_weekdays, expected.inputs.trainingWeekdays)
    && (active.input_activity_level ?? null) === expected.inputs.activity
    && (active.input_goal ?? null) === expected.inputs.goal
    && Number(active.goal_rate_bp_week ?? 0) === Number(expected.inputs.goalRateBpWeek ?? 0)
    && Number(active.kcal_min) === Number(expected.floors.kcalMin)
    && (active.kcal_min_source ?? null) === expected.floors.kcalMinSource
    && Number(active.protein_g_min) === Number(expected.floors.proteinGMin)
    && Number(active.fat_g_min) === Number(expected.floors.fatGMin)
    && Number(active.carb_g_min) === Number(expected.floors.carbGMin)
    // A revision without the frozen seed, or one frozen by older rules, is rewritten once so
    // the expenditure engine has the start this derivation would give it (step E1).
    && num(active.initial_tdee_kcal) === expected.seed.initialTdeeKcal
    && num(active.bmr_kcal) === expected.seed.bmrKcal
    && (active.bmr_method ?? null) === expected.seed.bmrMethod
    && (active.activity_model_version ?? null) === expected.seed.activityModelVersion
    && (active.derivation_version ?? null) === expected.seed.derivationVersion;
}

type Plan =
  | { kind: "skip"; reason: RecomputeSkip; active: TargetProfile | null; today?: string }
  | { kind: "derive"; rev: number | null; active: TargetProfile | null;
      input: DeriveTargetRevisionInput; expected: Derived }
  /** A held account with a pace in force today or scheduled for a later date: one 0-pace
   *  revision per such date, each dated as the revision it supersedes. */
  | { kind: "neutralise"; active: TargetProfile | null; today: string;
      writes: { input: DeriveTargetRevisionInput; expected: Derived }[] };

type DayHints = Pick<RecomputeOptions, "clientDay" | "requestZone">;

async function plan(
  client: SupabaseClient, userId: string, todayOverride?: string, hints: DayHints = {},
): Promise<Plan> {
  const row = await readSettings(client, userId);
  if (!row) return { kind: "skip", reason: "no_settings", active: null };
  const today = todayOverride ?? resolveAccountDay({ purpose: "target recompute",
    clientDay: hints.clientDay, storedZone: row.time_zone, requestZone: hints.requestZone }).date;
  const active = await activeProfile(client, userId, today);
  if (!row.onboarded_at) return { kind: "skip", reason: "not_onboarded", active, today };
  // Only a revision this formula wrote, as derived or manual, is the recompute's to replace. A legacy
  // row (null formula or source, left null on purpose by the authority migration) cannot be
  // classified, and an adaptive or proposal revision is authoritative: both are left alone.
  // The account's own pace holds (G1–G3), read before the formula check: a held account whose
  // revision in force (adaptive or proposal included) still carries a pace is re-derived from its
  // profile at a 0 pace, so a new hold never leaves a deficit in force. Under 18 derives nothing.
  const eligibility = await readTargetEligibility(client, userId, today);
  // Under 18 nothing is derived at all (owner decisions 2026-10-08).
  if (isMinorOn(settingsFromRow(row).birthYear, today) || eligibility.minor) {
    return { kind: "skip", reason: "adult_only", active, today };
  }
  const held = !paceAllowed(eligibility);
  const future = await futureRevisions(client, userId, today);
  if (held) {
    // A hold leaves no date with a pace: the revision in force today and every revision
    // scheduled after it that carries one (adaptive and proposal revisions included) is
    // superseded on its own date by a 0-pace derivation from the profile, keeping that
    // revision's weigh-in weight and pins. Nothing scheduled can bring a deficit back later.
    const paced = [...(hasPace(active) ? [{ profile: active!, date: today }] : []),
      ...future.filter(hasPace).map((profile) => ({ profile, date: profile.effective_from }))];
    if (paced.length > 0) {
      const writes = [];
      for (const { profile, date } of paced) {
        const settings = settingsFromRow(row, pinsOf(profile));
        if (!isProfileComplete(settings)) {
          return { kind: "skip", reason: "incomplete_profile", active, today };
        }
        const dated = date === today ? eligibility
          : await readTargetEligibility(client, userId, date);
        const input: DeriveTargetRevisionInput = {
          settings, latestWeighInKg: weighInKgToKeep(profile), today: date,
          trainingWeekdays: row.training_weekdays ?? [], source: targetSourceFor(settings),
          eligibility: dated,
        };
        writes.push({ input, expected: deriveTargetRevision(input) });
      }
      return { kind: "neutralise", active, today, writes };
    }
  }
  if (active && (active.formula_name !== TARGET_FORMULA_NAME
    || (active.target_source !== "derived" && active.target_source !== "manual"))) {
    return { kind: "skip", reason: "authoritative_formula", active, today };
  }
  const pins = active ? { trainingKcal: num(active.pin_training_kcal),
    restKcal: num(active.pin_rest_kcal), proteinG: num(active.pin_protein_g) } : null;
  const rowPins = { trainingKcal: row.training_kcal, restKcal: row.rest_kcal, proteinG: num(row.protein_g) };
  const rowHasPins = rowPins.trainingKcal !== null || rowPins.restKcal !== null || rowPins.proteinG !== null;
  if (pins && rowHasPins && !samePins(pins, rowPins)) {
    return { kind: "skip", reason: "pins_differ", active, today };
  }
  const settings = settingsFromRow(row, pins);
  if (!isProfileComplete(settings)) {
    return { kind: "skip", reason: "incomplete_profile", active, today };
  }
  if (future.length > 0) {
    return { kind: "skip", reason: "future_revision", active, today };
  }
  const latestWeighInKg = weighInKgToKeep(active);
  const trainingWeekdays = row.training_weekdays ?? [];
  const input: DeriveTargetRevisionInput = {
    settings, latestWeighInKg, today, trainingWeekdays, source: targetSourceFor(settings),
    eligibility,
  };
  return { kind: "derive", rev: row.rev, active, input, expected: deriveTargetRevision(input) };
}

/**
 * Bring the account's active derived revision in line with its current `user_settings` row.
 * Writes through `writeDerivedTargets` (the `write_target_revision` RPC), never raw SQL.
 */
export async function recomputeDerivedTarget(
  client: SupabaseClient, userId: string, options: RecomputeOptions = {},
): Promise<RecomputeOutcome> {
  let written: { revision: TargetRevision; rounds: number } | null = null;
  // The date every read in this run uses: the caller's, else the account zone's from the first plan.
  let today = options.today;
  const finish = async (next: Plan): Promise<RecomputeOutcome | null> => {
    // A skip after a write (an adaptive revision won the race, the profile became incomplete) is
    // reported as the skip: the derived row written earlier is not the one left in force.
    if (next.kind === "skip") {
      // The 0-pace revisions a hold wrote stay in force on their own dates under a later one.
      if (written && next.reason === "future_revision") return settled();
      return { status: "skipped", reason: next.reason, active: next.active };
    }
    if (next.kind === "neutralise") return null;
    if (next.active && revisionMatches(next.active, next.expected)) {
      return written ? settled() : { status: "unchanged", active: next.active, expected: next.expected };
    }
    return null;
  };
  const settled = async (): Promise<RecomputeOutcome> => ({ status: "written",
    active: await activeProfile(client, userId, today), revision: written!.revision,
    rounds: written!.rounds });
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const next = await plan(client, userId, today, options);
    today ??= next.kind === "derive" ? next.input.today : next.today;
    const done = await finish(next);
    if (done) return done;
    if (next.kind === "neutralise") {
      if (options.dryRun) {
        return { status: "would_write", active: next.active, expected: next.writes[0].expected };
      }
      // Unconditional writes (`write_target_revision`): the conditional RPC refuses any date with
      // a later revision, and a 0 pace is the safe side of any race. The next round verifies.
      let last: TargetRevision | null = null;
      for (const write of next.writes) last = await writeDerivedTargets(client, userId, write.input);
      if (last) written = { revision: last, rounds: round };
      continue;
    }
    if (next.kind !== "derive") throw new Error("unreachable");
    if (options.dryRun) return { status: "would_write", active: next.active, expected: next.expected };
    const revision = await writeDerivedTargetsIfActive(client, userId, next.input,
      next.active?.id ?? null, next.rev);
    // null: another revision became active after this plan read it. Re-plan from the new state.
    if (revision) written = { revision, rounds: round };
    // The next round re-reads settings and the active revision; a match ends the run, and a newer
    // settings row (another save landed meanwhile) is derived again.
  }
  // A last-round write is verified once more before it counts as settled.
  const final = await plan(client, userId, today);
  const done = await finish(final);
  if (done) return done;
  return { status: "unsettled", active: await activeProfile(client, userId, today),
    rounds: MAX_ROUNDS };
}

/**
 * After a write that can add or remove a pace hold (a `conditions` change, or a dietary profile
 * that holds the pace), bring the derived revision in line with it: a new hold sets the pace to 0
 * now, not at the next profile edit, and a removed hold restores the stored preset. Best effort:
 * a failure is logged and the next settings op retries, never failing the rule write itself.
 */
export async function recomputeAfterHoldChange(
  client: SupabaseClient, userId: string, purpose: string,
): Promise<void> {
  try {
    await recomputeDerivedTarget(client, userId);
  } catch (e) {
    console.error(`${purpose}: target recompute for ${userId} failed: ${
      e instanceof Error ? e.message : "unknown"}`);
  }
}
