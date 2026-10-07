/** Phase 6 wire types — `docs/specs/phase-6-estimator.md` "API changes", verbatim, plus the
 *  `target_profiles` row shape and the `ProposedTargets` alias the contracts name. */
import type {
  ActivityLevel, Goal, KcalMinSource, Macros, Settings, TargetRevision, TargetSource,
  TargetWeightSource,
} from "@/lib/types";
import type { ActivityContextV1 } from "@/lib/activity/summary";

/** How many dated `expenditure_estimates` rows the weight-trend line reads (design §8.2). */
export const WEIGHT_TREND_SERIES_DAYS = 21;

export type ExpenditureResponse = {
  status: "burn_in" | "held" | "estimating" | "blocked";
  localDate: string;
  tdeeKcal: number | null;          // null in burn_in
  weightTrendKg: number | null;     // null until status leaves burn_in
  /**
   * The dated series behind `weightTrendKg`: the last `WEIGHT_TREND_SERIES_DAYS` stored trend
   * values, oldest first, as `/api/expenditure` returns them. A `null` is a day the engine stored
   * no trend, never a zero. Optional, because a payload cached before this field existed has no
   * key at all, and because the coach's expenditure port does not read it (design §8.2).
   */
  weightTrendSeriesKg?: (number | null)[];
  confidence: number;               // 0..1
  intakeCompleteness: number;       // qualified days ÷ 14
  qualifiedDays: number;            // exp-3: last 28 (exp-2 rows: last 21)
  weighInCount: number;             // exp-3: last 28 (exp-2 rows: last 21)
  reason: string | null;            // "Learning — Weigh-ins cover 19 of 24 days"
  engineVersion: string;
  activityContext?: ActivityContextV1;
  /** The starting estimate: the seed frozen on the active target revision (step E1). */
  profileTdeeKcal?: number | null;
  learningDaysRemaining?: number;
  /**
   * TDEE step E (exp-3.0.0, docs/specs/phase-16-adaptive-handoff.md). All optional: an exp-2 row
   * or a payload cached before them has no key. `phase`: starting (seed only, tdeeKcal null),
   * provisional (learning from the 14-day window), adaptive (the 28-day window).
   * `tdeeLowKcal`–`tdeeHighKcal` is an empirical variation band, not a confidence interval.
   */
  phase?: "starting" | "provisional" | "adaptive" | null;
  tdeeLowKcal?: number | null;
  tdeeHighKcal?: number | null;
  dataWeight?: number | null;
  seedSource?: "revision" | "live_profile" | null;
  proposalEligible?: boolean | null;
  reviewFlag?: "far_from_seed" | "bmr_bounds" | null;
  /** exp-3.1.0: a periodic fluid swing (days) the estimate corrects for, e.g. a menstrual cycle. */
  fluidCycleDays?: number | null;
};

export type ProposedTargets = {
  kcalTrain: number; kcalRest: number;
  proteinG: number; fatG: number; carbG: number;
  deltaKcalTrain: number; deltaKcalRest: number;
  raisedToFloor: boolean;           // §3.4 step 5 fired
};

export type ProposalSummary = {
  id: string; weekStart: string; createdAt: string;
  status: "pending" | "approved" | "rejected";
  basedOnEstimateId: string | null;
  proposed: ProposedTargets;
  activityContext?: ActivityContextV1;
};

export type DecideRequest = { decision: "approve" | "reject"; expectedStatus: "pending" };
export type DecideResponse = { status: "approved" | "rejected"; targetProfileId: string | null };

export type TargetsRequest = {
  mode: "grams" | "percent"; effectiveFrom: string;
  kcalTrain: number; kcalRest: number;
  grams?: { proteinG: number; fatG: number; carbG: number };
  percent?: { proteinPct: number; fatPct: number; carbPct: number };
  goalRateBpWeek?: number; maxWeeklyKcalStep?: number;
};

export type TargetsResponse = {
  id: string; mode: "grams" | "percent";
  resolved: { training: Macros; rest: Macros }; raisedToFloor: boolean;
  revision?: TargetRevision | null;
};

export type TargetAuthorityRequest = {
  operation: "derive";
  source: Extract<TargetSource, "derived" | "manual">;
  effectiveFrom: string;
  latestWeighInKg: number | null;
  trainingWeekdays: number[];
  settings: Pick<Settings,
    "sex" | "birthYear" | "heightCm" | "weightKg" | "bodyFatPct" | "bodyFatSource"
    | "bodyFatMeasuredOn" | "activityLevel" | "goal" | "goalRateBpWeek" | "trainingKcal"
    | "restKcal" | "proteinG">;
};

export type TargetRestoreRequest = {
  operation: "restore";
  revisionId: string;
  effectiveFrom: string;
};

export type JobResponse = {
  ran: number; skipped: number; errors: number;
  /** Set when the run stopped at its time budget; the next fire of the period resumes after it. */
  incomplete?: true;
  /** Set when another run held this job's pass; this one did nothing. */
  busy?: true;
};

/** The legacy profile columns plus U1's additive authority-revision fields. */
export type TargetProfile = {
  id: string; user_id: string; effective_from: string; rev: number;
  kcal_train: number; kcal_rest: number;
  authored_by: "coach" | "engine_proposal" | "user";
  mode: "grams" | "percent";
  protein_g: number | null; fat_g: number | null; carb_g: number | null;
  protein_pct: number | null; fat_pct: number | null; carb_pct: number | null;
  kcal_min: number; protein_g_min: number; fat_g_min: number; carb_g_min: number;
  goal_rate_bp_week: number; max_weekly_kcal_step: number;
  /** Absent on a row read from a database that predates step D. */
  kcal_min_source?: KcalMinSource | null;
  notes: string | null;
  target_source?: TargetSource | null;
  training_macros?: Macros | null;
  rest_macros?: Macros | null;
  pin_training_kcal?: number | null;
  pin_rest_kcal?: number | null;
  pin_protein_g?: number | null;
  input_weight_kg?: number | null;
  input_weight_source?: TargetWeightSource | null;
  input_training_weekdays?: number[] | null;
  input_activity_level?: ActivityLevel | null;
  input_goal?: Goal | null;
  formula_name?: string | null;
  /** TDEE step E1: the frozen formula seed; absent or null on rows written before it. */
  initial_tdee_kcal?: number | null;
  bmr_kcal?: number | null;
  bmr_method?: "mifflin" | "katch" | null;
  activity_model_version?: string | null;
  derivation_version?: string | null;
};
