/**
 * Target reads and the single authored write path. Every write re-applies the §3.4 floor sequence
 * server-side: the client copy is for display, never for authority (spec "Security").
 *
 * `activeTargets` returning null means no target exists yet. Callers must surface profile setup.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import {
  deriveTargetRevision, targetSourceFor, type DeriveTargetRevisionInput,
  type TargetRevisionFloors,
} from "@/lib/profile/derive";
import type { Goal, TargetRevision, TargetSeed } from "@/lib/types";
import {
  applyFloors, percentToGrams, resolveProfileMacros, validatePercentProfile,
  type MacroFloors,
} from "@/lib/targets/percent";
import type { TargetProfile, TargetsRequest, TargetsResponse } from "@/lib/api-types";
import { targetRevisionFromProfile, targetSeedFromProfile } from "@/lib/targets/revision";
import { ACCOUNT_DAY_LAST_RESORT_ZONE, accountDay, isoDateIn } from "@/lib/server/account-day";
import { readTargetEligibility } from "@/lib/server/target-eligibility";
import {
  AdultOnlyError, paceAllowed, type TargetEligibility,
} from "@/lib/profile/rate-eligibility";
import { RATE_PRESETS_BP, validateRate } from "@/lib/profile/rate-goal";
import {
  rpcWriteTargetRevision, rpcWriteTargetRevisionIfActive, rpcWriteTargetRevisionPair,
} from "@/lib/server/target-writes";

export { targetRevisionFromProfile } from "@/lib/targets/revision";

export class FloorViolationError extends HttpError {
  constructor(code: string, message: string,
    public readonly minProteinPct: number, public readonly minFatPct: number) {
    super(422, code, message);
    this.name = "FloorViolationError";
  }
}

/**
 * The UTC date: what Postgres `current_date` answers inside the SQL pickers. It is NOT an
 * account's day and no target read defaults to it; `accountDay` (lib/server/account-day.ts) is.
 */
export function today(now: Date = new Date()): string {
  return isoDateIn(ACCOUNT_DAY_LAST_RESORT_ZONE, now);
}

/**
 * The revision in force on `effectiveOn`. Without a date, the account's own day (t24b: its stored
 * zone, else UTC as the logged last resort), never the UTC date.
 */
export async function activeProfile(
  client: SupabaseClient, userId: string, effectiveOn?: string,
): Promise<TargetProfile | null> {
  effectiveOn ??= (await accountDay(client, userId, { purpose: "activeProfile" })).date;
  const scoped = client.from("target_profiles").select("*").eq("user_id", userId);
  // Some bounded in-memory adapters intentionally omit range operators; no profile is safer than
  // silently treating a future profile as active. Real Supabase builders always provide `lte`.
  if (typeof scoped.lte !== "function") return null;
  const { data, error } = await scoped.lte("effective_from", effectiveOn)
    .order("effective_from", { ascending: false }).order("rev", { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw error;
  return (data as TargetProfile | null) ?? null;
}

function seedColumns(seed: TargetSeed | null) {
  return {
    initial_tdee_kcal: seed?.initialTdeeKcal ?? null,
    bmr_kcal: seed?.bmrKcal ?? null,
    bmr_method: seed?.bmrMethod ?? null,
    activity_model_version: seed?.activityModelVersion ?? null,
    derivation_version: seed?.derivationVersion ?? null,
  };
}

function revisionPayload(
  revision: TargetRevision,
  effectiveFrom = revision.effectiveFrom,
  floors?: TargetRevisionFloors,
  requestId?: string,
) {
  return {
    effective_from: effectiveFrom,
    target_source: revision.source,
    training_macros: revision.training,
    rest_macros: revision.rest,
    pin_training_kcal: revision.pins.trainingKcal,
    pin_rest_kcal: revision.pins.restKcal,
    pin_protein_g: revision.pins.proteinG,
    input_weight_kg: revision.inputs.weightKg,
    input_weight_source: revision.inputs.weightSource,
    input_training_weekdays: revision.inputs.trainingWeekdays,
    input_activity_level: revision.inputs.activity,
    input_goal: revision.inputs.goal,
    // Written on every revision, so restore and Undo keep the rate (step D); before this the
    // database default 0 won on every write.
    goal_rate_bp_week: revision.inputs.goalRateBpWeek,
    formula_name: revision.inputs.formulaName,
    // TDEE step E1: the frozen seed travels with the revision, so restore and Undo keep it.
    ...seedColumns(revision.seed ?? null),
    ...(requestId ? { request_id: requestId } : {}),
    ...(floors ? {
      kcal_min: floors.kcalMin,
      kcal_min_source: floors.kcalMinSource,
      protein_g_min: floors.proteinGMin,
      fat_g_min: floors.fatGMin,
      carb_g_min: floors.carbGMin,
    } : {}),
  };
}

/**
 * Every write goes through the service-role RPCs (lib/server/target-writes.ts) for `userId`, the
 * id the caller verified; `authenticated` cannot execute them (migration 20261228090000), so the
 * checks in this module cannot be skipped from a phone. Reads stay on the caller's client.
 */
async function writeRevisionRow(
  userId: string,
  payload: Record<string, unknown>,
): Promise<TargetProfile> {
  const { data, error } = await rpcWriteTargetRevision(userId, payload);
  if (error) throw error;
  return data as TargetProfile;
}

async function persistRevision(
  userId: string,
  revision: TargetRevision,
  effectiveFrom?: string,
  floors?: TargetRevisionFloors,
  requestId?: string,
): Promise<TargetRevision> {
  const row = await writeRevisionRow(
    userId, revisionPayload(revision, effectiveFrom, floors, requestId));
  const persisted = targetRevisionFromProfile(row);
  if (!persisted) throw new Error("Target authority returned an incomplete revision");
  return persisted;
}

/**
 * The input with the account's own pace holds and stored birth year, judged on the revision's
 * own date (lib/server/target-eligibility.ts). A server caller that already read them for that
 * date (the recompute plans with them) passes them in; nothing taken from a request body ever
 * carries them, and a birth year in the request body can never lift the stored adult floor.
 */
async function withEligibility(
  client: SupabaseClient, userId: string, input: DeriveTargetRevisionInput,
): Promise<DeriveTargetRevisionInput> {
  return input.eligibility ? input
    : { ...input, eligibility: await readTargetEligibility(client, userId, input.today) };
}

export async function writeDerivedTargets(
  client: SupabaseClient, userId: string, rawInput: DeriveTargetRevisionInput, requestId?: string,
): Promise<TargetRevision> {
  const input = await withEligibility(client, userId, rawInput);
  const revision = deriveTargetRevision({ ...input, source: targetSourceFor(input.settings) });
  return persistRevision(userId, revision, undefined, revision.floors, requestId);
}

/**
 * Write a revision exactly as given (`write_target_revision`, unconditional). Only the server
 * recompute calls it, to supersede a paced revision at a 0 pace when the profile cannot derive
 * (lib/server/target-recompute.ts); nothing taken from a request body reaches it.
 */
export async function writeRevisionCopy(
  userId: string, revision: TargetRevision,
): Promise<TargetRevision> {
  return persistRevision(userId, revision, revision.effectiveFrom, revision.floors);
}

/**
 * Like writeDerivedTargets, but only while `expectedActiveId` (null: no active revision) is still
 * the revision active on the new row's date and, when given, `expectedSettingsRev` is still the
 * `user_settings` rev the caller derived from. Returns null and writes nothing otherwise
 * (`write_target_revision_if_active`).
 */
export async function writeDerivedTargetsIfActive(
  client: SupabaseClient, userId: string, rawInput: DeriveTargetRevisionInput,
  expectedActiveId: string | null, expectedSettingsRev: number | null = null,
): Promise<TargetRevision | null> {
  const input = await withEligibility(client, userId, rawInput);
  const revision = deriveTargetRevision({ ...input, source: input.source ?? targetSourceFor(input.settings) });
  const { data, error } = await rpcWriteTargetRevisionIfActive(userId,
    revisionPayload(revision, undefined, revision.floors), expectedActiveId, expectedSettingsRev);
  if (error) throw error;
  if ((data as { conflict?: unknown } | null)?.conflict === true) return null;
  const persisted = targetRevisionFromProfile(data as TargetProfile);
  if (!persisted) throw new Error("Target authority returned an incomplete revision");
  return persisted;
}

export type TargetRevisionWrite = {
  operation: "derive";
  input: DeriveTargetRevisionInput;
  requestId?: string;
};

async function plannedRevision(
  client: SupabaseClient,
  userId: string,
  write: TargetRevisionWrite,
): Promise<{ revision: TargetRevision; floors: TargetRevisionFloors }> {
  const input = await withEligibility(client, userId, write.input);
  const revision = deriveTargetRevision({
    ...input,
    source: targetSourceFor(input.settings),
  });
  return { revision, floors: revision.floors };
}

/** The optional Undo predecessor and the real write share one database transaction. */
export async function writeTargetRevisionSet(
  client: SupabaseClient,
  userId: string,
  current: TargetRevisionWrite,
  predecessor?: TargetRevisionWrite,
): Promise<{ revision: TargetRevision; predecessor?: TargetRevision }> {
  // Each revision of the pair is judged on its own date (the stored birth year), so neither an
  // Undo predecessor nor the new revision can build a plan for an account under 18 on its date.
  const reads = new Map<string, ReturnType<typeof readTargetEligibility>>();
  const eligibilityOn = (date: string) => {
    if (!reads.has(date)) reads.set(date, readTargetEligibility(client, userId, date));
    return reads.get(date)!;
  };
  const [currentEligibility, predecessorEligibility] = await Promise.all([
    current.input.eligibility ?? eligibilityOn(current.input.today),
    predecessor ? predecessor.input.eligibility ?? eligibilityOn(predecessor.input.today) : null,
  ]);
  const held = (write: TargetRevisionWrite, eligibility = currentEligibility): TargetRevisionWrite =>
    ({ ...write, input: { ...write.input, eligibility } });
  if (!predecessor) {
    const revision = await writeDerivedTargets(client, userId, held(current).input,
      current.requestId);
    return { revision };
  }
  const [prior, next] = await Promise.all([
    plannedRevision(client, userId, held(predecessor, predecessorEligibility ?? currentEligibility)),
    plannedRevision(client, userId, held(current)),
  ]);
  const { data, error } = await rpcWriteTargetRevisionPair(userId,
    revisionPayload(prior.revision, undefined, prior.floors, predecessor.requestId),
    revisionPayload(next.revision, undefined, next.floors, current.requestId));
  if (error) throw error;
  const rows = data as { predecessor?: TargetProfile; revision?: TargetProfile };
  const persistedPredecessor = rows.predecessor
    ? targetRevisionFromProfile(rows.predecessor)
    : null;
  const persistedRevision = rows.revision ? targetRevisionFromProfile(rows.revision) : null;
  if (!persistedPredecessor || !persistedRevision) {
    throw new Error("Target authority returned an incomplete revision set");
  }
  return { predecessor: persistedPredecessor, revision: persistedRevision };
}

export async function restoreTargetRevision(
  client: SupabaseClient, userId: string, revisionId: string, effectiveFrom: string,
): Promise<TargetRevision> {
  const { data, error } = await client.from("target_profiles").select("*")
    .eq("user_id", userId).eq("id", revisionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "target_revision_not_found", "Target revision not found");
  const previous = targetRevisionFromProfile(data as TargetProfile);
  if (!previous) throw new HttpError(409, "legacy_target_revision", "Target revision cannot be restored");
  // Pace holds (onboarding v2 G1-G3): a restore never brings back a plan for an account under
  // 18, nor a loss or gain pace the account's current answers hold.
  const eligibility = await readTargetEligibility(client, userId, effectiveFrom);
  if (eligibility.minor) throw new AdultOnlyError();
  if (!paceAllowed(eligibility) && Number(previous.inputs.goalRateBpWeek ?? 0) !== 0) {
    throw new HttpError(409, "rate_not_eligible",
      "That plan had a weight-change pace. Your current answers keep calories at maintenance.");
  }
  return persistRevision(userId, {
    ...previous,
    effectiveFrom,
    inputs: { ...previous.inputs, effectiveDate: effectiveFrom },
  }, effectiveFrom, previous.floors);
}

/** The floor set in force comes only from the active canonical revision. */
function floorsOf(profile: TargetProfile): MacroFloors {
  return { kcalMin: profile.kcal_min, proteinGMin: Number(profile.protein_g_min),
    fatGMin: Number(profile.fat_g_min), carbGMin: Number(profile.carb_g_min) };
}

export async function floorsFor(client: SupabaseClient, userId: string): Promise<MacroFloors> {
  const profile = await activeProfile(client, userId);
  if (!profile) {
    throw new HttpError(409, "targets_need_profile", "Finish your profile before changing targets");
  }
  return floorsOf(profile);
}

export async function activeTargets(
  client: SupabaseClient, userId: string, effectiveOn?: string,
): Promise<TargetsResponse | null> {
  const profile = await activeProfile(client, userId, effectiveOn);
  if (!profile) return null;
  return targetsFromProfile(profile);
}

/** Resolve one already-selected row without another database read (export pages use this). */
export function targetsFromProfile(profile: TargetProfile): TargetsResponse {
  const revision = targetRevisionFromProfile(profile);
  if (revision) {
    return { id: profile.id, mode: profile.mode, raisedToFloor: false,
      resolved: { training: revision.training, rest: revision.rest }, revision };
  }
  const floors: MacroFloors = { kcalMin: profile.kcal_min,
    proteinGMin: Number(profile.protein_g_min), fatGMin: Number(profile.fat_g_min),
    carbGMin: Number(profile.carb_g_min) };
  const grams = profile.mode === "percent"
    ? percentToGrams(profile.kcal_train, { proteinPct: Number(profile.protein_pct),
        fatPct: Number(profile.fat_pct), carbPct: Number(profile.carb_pct) })
    : { proteinG: Number(profile.protein_g), fatG: Number(profile.fat_g),
        carbG: Number(profile.carb_g) };
  const resolved = resolveProfileMacros({ kcalTrain: profile.kcal_train,
    kcalRest: profile.kcal_rest, ...grams }, floors);
  return { id: profile.id, mode: profile.mode, raisedToFloor: resolved.raisedToFloor,
    resolved: { training: resolved.training, rest: resolved.rest }, revision: null };
}

/**
 * The pace an authored (pinned) revision stores. A held account keeps 0 whatever the body sends.
 * Otherwise a rate in the body must be 0 or a preset for the account's STORED goal, exactly as
 * the derive path requires (audit 2026-10-10 A004); an unknown goal admits only 0. Without one,
 * the revision it pins over keeps its rate when that rate is valid for the stored goal, and 0
 * otherwise: an adaptive revision's rate never carries onto a goal it is not a preset for.
 */
function authoredRate(
  requested: number | undefined, goal: unknown, eligibility: TargetEligibility,
  inherited: number | string | null | undefined,
): number {
  if (!paceAllowed(eligibility)) return 0;
  if (requested === undefined) {
    const rate = Number(inherited ?? 0);
    return rateFitsGoal(goal, rate) ? rate : 0;
  }
  if (!rateFitsGoal(goal, requested)) {
    throw new HttpError(400, "rate_not_valid", "That pace is not one of the choices for your goal.");
  }
  return requested;
}

/** 0, or a preset for the stored goal; an unknown goal admits only 0. */
function rateFitsGoal(goal: unknown, rate: number): boolean {
  return rate === 0 || (Number.isFinite(rate) && isGoal(goal) && validateRate(goal, rate));
}

function isGoal(value: unknown): value is Goal {
  return typeof value === "string" && Object.hasOwn(RATE_PRESETS_BP, value);
}

export async function authorTargets(
  client: SupabaseClient, userId: string, req: TargetsRequest,
): Promise<TargetsResponse> {
  // The floors in force on the day the phone dates this write by (t24b), not the UTC date; a
  // phone day before the account's first revision (travel) reads the account's own day instead.
  const active = await activeProfile(client, userId, req.effectiveFrom)
    ?? await activeProfile(client, userId);
  if (!active) {
    throw new HttpError(409, "targets_need_profile", "Finish your profile before changing targets");
  }
  const floors = floorsOf(active);

  if (req.mode === "percent") {
    if (!req.percent) throw new HttpError(400, "bad_request", "percent body required");
    const check = validatePercentProfile(req.percent, req.kcalTrain, req.kcalRest, floors);
    if (!check.ok) {
      throw new FloorViolationError(check.error,
        `At ${Math.min(req.kcalTrain, req.kcalRest)} kcal this split falls under a floor.`,
        check.minProteinPct, check.minFatPct);
    }
  } else if (!req.grams) {
    throw new HttpError(400, "bad_request", "grams body required");
  }

  const raw = req.mode === "percent"
    ? percentToGrams(req.kcalTrain, req.percent as NonNullable<TargetsRequest["percent"]>)
    : (req.grams as NonNullable<TargetsRequest["grams"]>);
  const floored = applyFloors(req.kcalTrain, raw, floors);
  const resolved = resolveProfileMacros({
    kcalTrain: floored.kcal,
    kcalRest: Math.max(req.kcalRest, floors.kcalMin),
    ...floored.grams,
  }, floors);
  const [settings, eligibility] = await Promise.all([
    client.from("user_settings")
      .select("weight_kg, training_weekdays, activity_level, goal")
      .eq("user_id", userId).maybeSingle(),
    readTargetEligibility(client, userId, req.effectiveFrom),
  ]);
  if (settings.error) throw settings.error;
  // Under 18: no plan, pinned or derived (owner decision 2026-10-08).
  if (eligibility.minor) throw new AdultOnlyError();
  const goalRateBpWeek = authoredRate(req.goalRateBpWeek, settings.data?.goal, eligibility,
    active.goal_rate_bp_week);
  const weight = Number(settings.data?.weight_kg);
  const profile = await writeRevisionRow(userId, {
    effective_from: req.effectiveFrom,
    target_source: "manual",
    mode: req.mode,
    training_macros: resolved.training,
    rest_macros: resolved.rest,
    pin_training_kcal: req.kcalTrain,
    pin_rest_kcal: req.kcalRest,
    pin_protein_g: floored.grams.proteinG,
    input_weight_kg: Number.isFinite(weight) && weight > 0 ? weight : null,
    input_weight_source: Number.isFinite(weight) && weight > 0 ? "onboarding" : null,
    input_training_weekdays: settings.data?.training_weekdays ?? null,
    input_activity_level: settings.data?.activity_level ?? null,
    input_goal: settings.data?.goal ?? null,
    formula_name: "manual-macro-v1",
    protein_pct: req.percent?.proteinPct ?? null,
    fat_pct: req.percent?.fatPct ?? null,
    carb_pct: req.percent?.carbPct ?? null,
    kcal_min: floors.kcalMin,
    protein_g_min: floors.proteinGMin,
    fat_g_min: floors.fatGMin,
    carb_g_min: floors.carbGMin,
    // A manual row keeps the rate and the minimum's provenance of the revision it pins over
    // (step D); before this the database default zeroed a confirmed rate on every pin.
    // A held account (pregnancy, eating disorder, kidney disease, clinician diet) keeps 0.
    goal_rate_bp_week: goalRateBpWeek,
    kcal_min_source: active.kcal_min_source ?? "legacy_default",
    // Pins change the numbers, not the formula start the engine learns from (step E1).
    ...seedColumns(targetSeedFromProfile(active)),
    max_weekly_kcal_step: req.maxWeeklyKcalStep ?? 150,
  });
  const response = targetsFromProfile(profile);
  return { ...response, raisedToFloor: floored.raisedToFloor || response.raisedToFloor };
}
