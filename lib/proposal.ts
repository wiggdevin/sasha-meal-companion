/**
 * The Sunday proposal — architecture §4.3's proposal block, transcribed:
 *
 *   kcal = tdee + clamp(goal_rate_bp_week ÷ 10000 × weight_trend_kg × 7700 ÷ 7,
 *                       −20 % of tdee, +10 % of tdee)          — lib/profile/rate-goal.ts
 *   protein unchanged (authored, held across training and rest days)
 *   fat ≥ fat_g_min (50 g) and ≥ the authored value unless the reviewer lowers it
 *   carbs = the remainder; then the §3.4 floor sequence runs
 *   training / rest split preserved in the same ratio; |Δkcal| ≤ max_weekly_kcal_step
 *   kcal ≥ kcal_min and ≥ 4·protein_g_min + 9·fat_g_min
 *
 * Pure. It returns a proposal, a refusal, or silence; it never writes anything.
 */
import type { ExpenditureResult } from "@/lib/expenditure";
import type { ActivityContextV1 } from "@/lib/activity/summary";
import { macroMinimumKcal, rateTarget } from "@/lib/profile/rate-goal";
import {
  applyFloors, KCAL_PER_G_CARB, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN, percentToGrams,
  type GramTargets, type MacroFloors,
} from "@/lib/targets/percent";
import type { ProposedTargets, TargetProfile } from "@/lib/api-types";

export const DAYS_PER_WEEK = 7;
/** Ruling R4: a weekly-average move smaller than this is noise, not a reason to ask. */
export const MIN_PROPOSAL_MOVE_KCAL = 75;

/**
 * Training days per week from the revision's own schedule. It used to be a constant 4 (a hard-coded
 * four-day week), which weighted every other account's weekly average wrong.
 * A revision with no stored schedule gets no proposal rather than a guessed four.
 */
export function trainingDaysPerWeek(active: TargetProfile): number | null {
  const weekdays = active.input_training_weekdays;
  if (!Array.isArray(weekdays)) return null;
  return new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)).size;
}

export type BuildProposalResult =
  | { kind: "proposal"; proposed: ProposedTargets }
  | { kind: "blocked"; reason: string }
  | { kind: "none"; reason: string };

export function proposalActivitySentence(
  activityContext?: ActivityContextV1,
): string | null {
  if (activityContext?.smoothing !== "corroborated") return null;
  if (activityContext.band === "lower") {
    return "Your steps were lower than usual and agreed with your logs and weight, so the burn estimate moved down faster. Device calories were not added.";
  }
  if (activityContext.band === "higher") {
    return "Your steps were higher than usual and agreed with your logs and weight, so the burn estimate moved up faster. Device calories were not added.";
  }
  return null;
}

function floorsOf(active: TargetProfile): MacroFloors {
  return { kcalMin: active.kcal_min, proteinGMin: active.protein_g_min,
    fatGMin: active.fat_g_min, carbGMin: active.carb_g_min };
}

/** The gram set the profile authors today, at its own training-day calories. */
function authoredGrams(active: TargetProfile): GramTargets {
  if (active.mode === "percent") {
    return percentToGrams(active.kcal_train, {
      proteinPct: Number(active.protein_pct), fatPct: Number(active.fat_pct),
      carbPct: Number(active.carb_pct) });
  }
  return { proteinG: Number(active.protein_g), fatG: Number(active.fat_g),
    carbG: Number(active.carb_g) };
}

/**
 * One scalar for both day types, so the training / rest ratio survives. A single factor is also
 * what keeps |Δkcal| ≤ cap on *both* days: clamping the two days independently would let the
 * larger day hit the cap and the smaller one not, silently changing the ratio.
 *
 * A day's move is `kcal·|factor − 1|`, so the largest day type sets the allowed swing in *both*
 * directions: `|factor − 1| ≤ cap ÷ max(kcal_train, kcal_rest)`. Using the smaller day for the
 * downward bound would let the larger one fall past the cap (2200 → 2011 on a 150 cap).
 */
function clampFactor(rawFactor: number, kcalTrain: number, kcalRest: number, cap: number): number {
  const largestDay = Math.max(kcalTrain, kcalRest);
  if (largestDay === 0) return 1;
  const step = cap / largestDay;
  return Math.min(1 + step, Math.max(1 - step, rawFactor));
}

export function buildProposal(args: {
  estimate: ExpenditureResult; active: TargetProfile;
}): BuildProposalResult {
  const { estimate, active } = args;
  if (estimate.status !== "estimating" || estimate.tdeeKcal === null) {
    return { kind: "none", reason: estimate.reason ?? `status is ${estimate.status}` };
  }
  // exp-3.0.0 (ruling R4): measurement and eligibility are separate. A valid estimate may still be
  // too young, too wide, flagged or disagreeing; the engine says which.
  if (estimate.proposalEligible !== true) {
    return { kind: "none", reason: estimate.reason ?? "Not enough steady data for a change yet" };
  }

  // A nonzero rate needs a weight to be a rate of; treating a missing trend as 0 kg would
  // silently propose maintenance for someone who chose to lose or gain (step D ruling).
  if (active.goal_rate_bp_week !== 0 && estimate.weightTrendKg === null) {
    return { kind: "none", reason: "No weight trend yet to apply the goal rate to" };
  }
  const trainingDays = trainingDaysPerWeek(active);
  if (trainingDays === null) {
    return { kind: "none", reason: "No training schedule on the current target" };
  }
  const floors = floorsOf(active);
  const { targetKcal: targetDailyAvg } = rateTarget({
    tdeeKcal: estimate.tdeeKcal,
    weightBasisKg: estimate.weightTrendKg ?? 0,
    goalRateBpWeek: active.goal_rate_bp_week,
    kcalMin: Math.max(active.kcal_min, macroMinimumKcal(floors)),
  });

  const currentDailyAvg =
    (trainingDays * active.kcal_train + (DAYS_PER_WEEK - trainingDays) * active.kcal_rest)
    / DAYS_PER_WEEK;
  const cap = active.max_weekly_kcal_step;
  const factor = clampFactor(
    currentDailyAvg === 0 ? 1 : targetDailyAvg / currentDailyAvg,
    active.kcal_train, active.kcal_rest, cap);
  const kcalTrainRaw = Math.round(active.kcal_train * factor);
  const kcalRestRaw = Math.round(active.kcal_rest * factor);

  const authored = authoredGrams(active);
  const proteinG = authored.proteinG;                       // protein never moves
  const fatG = Math.max(authored.fatG, active.fat_g_min);   // fat holds its floor and its author

  // §3.4 stores ONE gram set, and it is the training day's set (`percent.ts`
  // `resolveProfileMacros`). Carbs are the remainder on both day types (architecture §4.3), floored
  // only at the revision's `carb_g_min`. Holding the authored training carbs instead raised every
  // downward training day straight back to its old total, so a falling estimate could only ever
  // move the rest day (audit 2026-10-10 A157).
  const training = applyFloors(kcalTrainRaw, { proteinG, fatG, carbG: authored.carbG }, floors);
  const restCarb = Math.round(
    (kcalRestRaw - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB);
  const rest = applyFloors(kcalRestRaw, { proteinG, fatG, carbG: restCarb }, floors);

  const deltaKcalTrain = training.kcal - active.kcal_train;
  const deltaKcalRest = rest.kcal - active.kcal_rest;

  if (Math.abs(deltaKcalTrain) > cap || Math.abs(deltaKcalRest) > cap) {
    const needed = Math.max(Math.abs(deltaKcalTrain), Math.abs(deltaKcalRest));
    return { kind: "blocked", reason:
      `Holding the fat and protein floors needs ${needed} kcal, above the ${cap} kcal weekly step. This needs your review.` };
  }

  // Ruling R4: a move this small is noise, not a reason to ask. A floor conflict above still
  // reports `blocked`, because that is a problem with the current targets, whatever the estimate.
  const weeklyMove = Math.abs((trainingDays * deltaKcalTrain
    + (DAYS_PER_WEEK - trainingDays) * deltaKcalRest) / DAYS_PER_WEEK);
  if (weeklyMove < MIN_PROPOSAL_MOVE_KCAL) {
    return { kind: "none", reason: "Your current targets already fit your estimate" };
  }

  return { kind: "proposal", proposed: {
    kcalTrain: training.kcal, kcalRest: rest.kcal,
    proteinG: training.grams.proteinG, fatG: training.grams.fatG, carbG: training.grams.carbG,
    deltaKcalTrain, deltaKcalRest,
    raisedToFloor: training.raisedToFloor || rest.raisedToFloor,
  } };
}
