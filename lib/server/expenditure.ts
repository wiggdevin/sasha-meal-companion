/**
 * The only impure piece of the estimator: it reads the intake (lib/server/expenditure-intake.ts) and the weigh-ins, calls the
 * pure engine, and upserts one `expenditure_estimates` row per (user_id, local_date). The jobs
 * reach it through the privileged boundary (§2.2) with `p_user_id` from a query, never a body.
 *
 * Unit conversion happens in Lane P, not here and not in the view: `weigh_ins` returns each
 * sample's stored `value` and `unit` unconverted, and `weighInsKg` (contracts §2) runs every row
 * through `toCanonical('body_mass', value, unit)`, so a legacy `lb` backfill row and a Phase 5
 * `kg` sample enter the engine on the same footing. Q never reads `weigh_ins` directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeActivity, ACTIVITY_BASELINE_DAYS, ACTIVITY_CURRENT_DAYS }
  from "@/lib/activity/summary";
import { healthTimeZone, type DailyHealthRow } from "@/lib/health/contract";
import { profileTdeeFor, seedFor, type SeedSource } from "@/lib/server/profile-tdee";
import { accountDay } from "@/lib/server/account-day";
import { HttpError } from "@/lib/server/auth";
import { intakeDays } from "@/lib/server/expenditure-intake";
import {
  ENGINE_VERSION, estimateExpenditure, fromDayNumber, startingRange, toDayNumber,
  type ExpenditureResult, type WeighIn,
} from "@/lib/expenditure";
import { WEIGHT_TREND_SERIES_DAYS, type ExpenditureResponse } from "@/lib/api-types";

/**
 * How far back the engine reads. The fade (lib/expenditure.ts `dataWeightFor`) counts lifetime
 * qualified days off this fetch, so it must stay well beyond any realistic logging gap or an
 * account that already earned full data weight would fall back toward its seed.
 */
export const HISTORY_DAYS = 1825;

/** Lane P's `lib/server/health-daily.ts` export, by contract (contracts §2). */
export type WeighInsPort =
  (client: SupabaseClient, userId: string, from: string, to: string) => Promise<WeighIn[]>;

export type ActivityDaysPort =
  (client: SupabaseClient, userId: string, from: string, to: string) => Promise<DailyHealthRow[]>;

export type EstimateDeps = {
  weighIns?: WeighInsPort;
  activityDays?: ActivityDaysPort;
  timeZone?: string;
};

/** The stored row carries where its seed came from (step E1); the pure engine does not know. */
export type StoredEstimate = ExpenditureResult & { seedSource?: SeedSource | null };

export async function timeZoneFor(admin: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await admin.from("user_settings")
    .select("time_zone").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return healthTimeZone(
    null, (data?.time_zone as string | null | undefined) ?? null, process.env.HEALTH_TZ,
  );
}

/** Ruling R3: the first-ever marked date, or null when the account has never marked a day. */
async function marksStartedOn(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.from("user_settings").select("day_marks_started_on")
    .eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const value = data?.day_marks_started_on;
  return typeof value === "string" ? value.slice(0, 10) : null;
}

export async function runEstimate(
  admin: SupabaseClient, userId: string, asOf: string, deps?: EstimateDeps,
): Promise<ExpenditureResult> {
  const port = deps?.weighIns;
  if (!port) {
    throw new HttpError(503, "unavailable",
      "No weigh-ins port installed — Phase 5 health data is not on this deployment.");
  }
  // The seed and the BMR bounds are this account's own (ruling 2026-09-22, step E1): an account with
  // no complete profile and no frozen seed holds and says why. It never borrows a number.
  const seed = await seedFor(admin, userId, asOf);
  if (!seed) {
    const held = heldWithoutProfile();
    await upsertEstimate(admin, userId, asOf, held);
    return held;
  }
  const from = fromDayNumber(toDayNumber(asOf) - HISTORY_DAYS);
  const activityFrom = fromDayNumber(
    toDayNumber(asOf) - ACTIVITY_CURRENT_DAYS - ACTIVITY_BASELINE_DAYS,
  );
  const [intake, weighIns, startedOn, activityRows] = await Promise.all([
    intakeDays(admin, userId, from, asOf),
    port(admin, userId, from, asOf),
    marksStartedOn(admin, userId),
    deps?.activityDays ? deps.activityDays(admin, userId, activityFrom, asOf) : [],
  ]);

  const activityContext = summarizeActivity(
    activityRows, asOf, healthTimeZone(null, deps?.timeZone, process.env.HEALTH_TZ),
  );
  const result: StoredEstimate = { ...estimateExpenditure({ asOf, intake, weighIns,
    seedKcal: seed.tdeeKcal, bmrKcal: seed.bmrKcal, marksStartedOn: startedOn, activityContext }),
  seedSource: seed.source };
  await upsertEstimate(admin, userId, asOf, result);
  return result;
}

export const HELD_WITHOUT_PROFILE_REASON =
  "Finish your profile — the estimate starts from your own numbers";

/** No profile, no seed: a held row with no number, so the card and the coach say what is missing. */
export function heldWithoutProfile(): ExpenditureResult {
  return {
    status: "held", phase: "starting", tdeeKcal: null, tdeeLowKcal: null, tdeeHighKcal: null,
    dataWeight: 0, proposalEligible: false, reviewFlag: null, fluidCycleDays: null,
    observedShortKcal: null,
    observedLongKcal: null, weightTrendKg: null, intakeAvgKcal: null,
    intakeCompleteness: 0, weighInCompleteness: 0, qualifiedDays: 0, weighInCount: 0,
    confidence: 0, reason: HELD_WITHOUT_PROFILE_REASON, engineVersion: ENGINE_VERSION,
    // Learning has not started: 0 here would read as "nothing left to learn".
    learningDaysRemaining: 21,
  };
}

export async function upsertEstimate(
  admin: SupabaseClient, userId: string, localDate: string, result: StoredEstimate,
): Promise<string> {
  const { data, error } = await admin.rpc("upsert_expenditure_estimate", {
    p_user_id: userId,
    p_row: {
      local_date: localDate, status: result.status, tdee_kcal: result.tdeeKcal,
      weight_trend_kg: result.weightTrendKg, intake_avg_kcal: result.intakeAvgKcal,
      intake_completeness: result.intakeCompleteness, qualified_days: result.qualifiedDays,
      weigh_in_count: result.weighInCount, confidence: result.confidence,
      reason: result.reason, engine_version: result.engineVersion,
      activity_context: result.activityContext ?? null,
      learning_days_remaining: result.learningDaysRemaining,
      phase: result.phase, tdee_low_kcal: result.tdeeLowKcal, tdee_high_kcal: result.tdeeHighKcal,
      data_weight: result.dataWeight, seed_source: result.seedSource ?? null,
      proposal_eligible: result.proposalEligible, review_flag: result.reviewFlag,
      fluid_cycle_days: result.fluidCycleDays,
    },
  });
  if (error) throw error;
  return String(data);
}

/**
 * The dated weight-trend series `/body` plots (design §8.2): the last `WEIGHT_TREND_SERIES_DAYS`
 * stored rows for this user, oldest first. A stored `null` stays `null` — `Sparkline` draws that
 * as a gap, and a zero there would read as a weight.
 *
 * A read of its own rather than a widening of `latestEstimate`, because that function is also the
 * coach's expenditure port (`lib/server/coach-ports.ts:29`, `lib/server/coach-context.ts:110`):
 * every coach turn would otherwise carry 21 extra rows for a line only `/body` draws.
 */
export async function weightTrendSeries(
  client: SupabaseClient, userId: string,
): Promise<(number | null)[]> {
  const { data, error } = await client.from("expenditure_estimates")
    .select("local_date, weight_trend_kg")
    .eq("user_id", userId)
    .order("local_date", { ascending: false })
    .limit(WEIGHT_TREND_SERIES_DAYS);
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) =>
    row.weight_trend_kg === null || row.weight_trend_kg === undefined
      ? null : Number(row.weight_trend_kg)).reverse();
}

/** Spec error case: no estimate yet is `200` with `burn_in` and nulls, never a 404. */
export async function latestEstimate(
  client: SupabaseClient, userId: string,
): Promise<ExpenditureResponse> {
  const { data, error } = await client.from("expenditure_estimates")
    .select("local_date, status, tdee_kcal, weight_trend_kg, intake_completeness, qualified_days, weigh_in_count, confidence, reason, engine_version, activity_context, learning_days_remaining, phase, tdee_low_kcal, tdee_high_kcal, data_weight, seed_source, proposal_eligible, review_flag, fluid_cycle_days")
    .eq("user_id", userId).order("local_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  // No estimate yet: the account's own day (t24b), never the server's UTC date.
  const today = data ? null : (await accountDay(client, userId, { purpose: "latestEstimate" })).date;
  const profileTdeeKcal = await profileTdeeFor(client, userId, data?.local_date ?? today);
  if (!data && profileTdeeKcal === null) {
    // Same answer the first job run will store, so the card does not say "learning" until cron.
    const { intakeAvgKcal, weighInCompleteness, ...held } = heldWithoutProfile();
    void intakeAvgKcal; void weighInCompleteness;
    return { ...held, localDate: today as string, profileTdeeKcal };
  }
  if (!data) {
    return { status: "burn_in", localDate: today as string,
      tdeeKcal: null, weightTrendKg: null, confidence: 0, intakeCompleteness: 0,
      qualifiedDays: 0, weighInCount: 0,
      reason: "Starting estimate — learning from your days, 0 of 14 counted",
      engineVersion: ENGINE_VERSION, profileTdeeKcal, learningDaysRemaining: 21,
      phase: "starting", ...(profileTdeeKcal === null ? {} : startingRange(profileTdeeKcal)),
      dataWeight: 0, proposalEligible: false, reviewFlag: null };
  }
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    status: data.status as ExpenditureResponse["status"],
    localDate: String(data.local_date).slice(0, 10),
    tdeeKcal: num(data.tdee_kcal), weightTrendKg: num(data.weight_trend_kg),
    confidence: Number(data.confidence ?? 0),
    intakeCompleteness: Number(data.intake_completeness ?? 0),
    qualifiedDays: Number(data.qualified_days ?? 0),
    weighInCount: Number(data.weigh_in_count ?? 0),
    reason: (data.reason as string | null) ?? null,
    engineVersion: String(data.engine_version ?? ENGINE_VERSION),
    activityContext: (data.activity_context as ExpenditureResponse["activityContext"]) ?? undefined,
    profileTdeeKcal,
    phase: (data.phase as ExpenditureResponse["phase"]) ?? null,
    tdeeLowKcal: num(data.tdee_low_kcal), tdeeHighKcal: num(data.tdee_high_kcal),
    dataWeight: num(data.data_weight),
    seedSource: (data.seed_source as ExpenditureResponse["seedSource"]) ?? null,
    proposalEligible: (data.proposal_eligible as boolean | null) ?? null,
    reviewFlag: (data.review_flag as ExpenditureResponse["reviewFlag"]) ?? null,
    fluidCycleDays: num(data.fluid_cycle_days),
    ...(data.learning_days_remaining === null || data.learning_days_remaining === undefined
      ? {} : { learningDaysRemaining: Number(data.learning_days_remaining) }),
  };
}
