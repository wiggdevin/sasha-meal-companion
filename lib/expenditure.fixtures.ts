/**
 * Deterministic synthetic series for the §4.3 acceptance backtests and
 * `scripts/backtest-estimator.ts`. Unseeded randomness is banned outright; noise comes from a
 * seeded linear congruential generator, so a scenario is byte-identical on every machine and CI.
 *
 * Anchors from `../analysis/targets.md`: BASE_KG 57.6 kg is §2's "The user is 127 lb"; BASE_TDEE 2130 is
 * §1's working number. Weight moves only through the energy balance, at the §4.3 approximation of
 * 7700 kcal/kg, plus whatever artefact the scenario adds on top.
 */
import {
  estimateExpenditure, fromDayNumber, KCAL_PER_KG, toDayNumber,
  type ExpenditureResult, type IntakeDay, type WeighIn,
} from "@/lib/expenditure";
import { summarizeActivity } from "@/lib/activity/summary";
import type { DailyHealthRow } from "@/lib/health/contract";

/**
 * The first client's seeds from analysis/targets.md §1 — "~2,130 kcal ← trained maintenance" and
 * "BMR (InBody, Katch-McArdle from 46.4 kg LBM) | 1,372 kcal". TEST SCENARIOS ONLY: the engine takes
 * the prior and the BMR per account (lib/server/expenditure.ts), never from a constant.
 */
export const PRIOR_KCAL = 2130;
export const BMR_KCAL = 1372;

/** Numerical Recipes' 32-bit LCG. */
export const LCG_A = 1_664_525;
export const LCG_C = 1_013_904_223;
export const LCG_M = 2 ** 32;

export const START_DATE = "2026-06-01";
export const SCENARIO_DAYS = 120;
export const BASE_KG = 57.6;
export const BASE_TDEE = 2130;
/** Scale noise, one standard step. Real bathroom scales are worse; this is enough to test the EMA. */
export const NOISE_KG = 0.25;
/** Logging noise on a qualified day. */
export const NOISE_KCAL = 120;

/** Scenario day index (0-based from START_DATE) for a replay date. */
export function toScenarioDay(date: string): number {
  return toDayNumber(date) - toDayNumber(START_DATE);
}

export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, LCG_A) + LCG_C) >>> 0;
    return state / LCG_M;
  };
}

export type Scenario = {
  label: string;
  asOf: string;
  weighIns: WeighIn[];
  intake: IntakeDay[];
  activityRows?: DailyHealthRow[];
};

export type ScenarioArgs = {
  label: string; seed: number; days?: number;
  /** True expenditure on day `d` (0-based from START_DATE). */
  tdee: (d: number) => number;
  /** What the user actually ate on day `d`. */
  intake: (d: number) => number;
  /** Artefact added to the SCALE reading on day `d` (water, cycle) — not real tissue. */
  artefactKg?: (d: number) => number;
  /** Scale noise, one standard step. Defaults to `NOISE_KG`; artefact-only scenarios set 0 so
   *  their readings are deterministic and the assertion is on the artefact, not a lucky draw. */
  noiseKg?: number;
  /** Intake noise amplitude. Worked examples set zero; legacy fixtures retain `NOISE_KCAL`. */
  noiseKcal?: number;
  /** Whether day `d` is fully logged (a qualified day). */
  logged?: (d: number) => boolean;
  /** Whether the user stepped on the scale on day `d`. */
  weighed?: (d: number) => boolean;
  /** Optional device observations. Null is missing; numeric zero remains an observation. */
  steps?: (d: number) => number | null;
  activeKcal?: (d: number) => number | null;
};

export function buildScenario(args: ScenarioArgs): Scenario {
  const days = args.days ?? SCENARIO_DAYS;
  const noise = lcg(args.seed);
  const logged = args.logged ?? (() => true);
  const weighed = args.weighed ?? (() => true);
  const artefact = args.artefactKg ?? (() => 0);
  const noiseKg = args.noiseKg ?? NOISE_KG;
  const noiseKcal = args.noiseKcal ?? NOISE_KCAL;

  const weighIns: WeighIn[] = [];
  const intake: IntakeDay[] = [];
  const activityRows: DailyHealthRow[] = [];
  let trueKg = BASE_KG;

  for (let d = 0; d < days; d += 1) {
    const date = fromDayNumber(toDayNumber(START_DATE) + d);
    const eaten = args.intake(d);
    const fed = logged(d);
    intake.push(fed
      ? { date, kcal: Math.round(eaten + (noise() - 0.5) * 2 * noiseKcal), energyCoverage: 1 }
      : { date, kcal: Math.round(eaten * 0.35), energyCoverage: 0.5 });
    if (weighed(d)) {
      const reading = trueKg + artefact(d) + (noise() - 0.5) * 2 * noiseKg;
      weighIns.push({ date, kg: Math.round(reading * 1000) / 1000 });
    }
    if (args.steps || args.activeKcal) {
      activityRows.push({
        local_date: date,
        steps: args.steps?.(d) ?? null,
        active_kcal: args.activeKcal?.(d) ?? null,
        sleep_minutes: null,
        body_mass_kg: null,
        resting_heart_rate: null,
        hrv_sdnn: null,
        readiness_score: null,
        sources: [],
        provenance: {},
      });
    }
    trueKg += (eaten - args.tdee(d)) / KCAL_PER_KG;
  }

  return { label: args.label, asOf: fromDayNumber(toDayNumber(START_DATE) + days), weighIns, intake,
    ...(activityRows.length > 0 ? { activityRows } : {}) };
}

const STEP_CHANGE_DAY = 60;
const ACTIVITY_CURRENT_START = 68;

function transitionSteps(current: number): (day: number) => number | null {
  return (day) => day < STEP_CHANGE_DAY ? 8_000 : day < ACTIVITY_CURRENT_START ? null : current;
}

export function activityDrop(): Scenario {
  return buildScenario({ label: "activity drop 8,000→4,800", seed: 2001, days: 75,
    noiseKg: 0, noiseKcal: 0,
    tdee: (day) => day >= STEP_CHANGE_DAY ? 1_880 : BASE_TDEE,
    intake: () => BASE_TDEE, steps: transitionSteps(4_800) });
}

export function activityUsual(): Scenario {
  return buildScenario({ label: "usual activity 8,000→7,800", seed: 2002, days: 75,
    noiseKg: 0, noiseKcal: 0,
    tdee: (day) => day >= STEP_CHANGE_DAY ? 1_880 : BASE_TDEE,
    intake: () => BASE_TDEE, steps: transitionSteps(7_800) });
}

export function activityRise(): Scenario {
  return buildScenario({ label: "activity rise 8,000→11,200", seed: 2003, days: 75,
    noiseKg: 0, noiseKcal: 0,
    tdee: (day) => day >= STEP_CHANGE_DAY ? 2_380 : BASE_TDEE,
    intake: () => BASE_TDEE, steps: transitionSteps(11_200) });
}

export function activityDisagreement(): Scenario {
  return buildScenario({ label: "activity disagreement", seed: 2004, days: 75,
    noiseKg: 0, noiseKcal: 0,
    tdee: (day) => day >= STEP_CHANGE_DAY ? 2_380 : BASE_TDEE,
    intake: () => BASE_TDEE, steps: transitionSteps(4_800) });
}

export function activityLoggingGap(): Scenario {
  return buildScenario({ label: "activity rise with logging gap", seed: 2005, days: 75,
    noiseKg: 0, noiseKcal: 0,
    tdee: (day) => day >= STEP_CHANGE_DAY ? 2_380 : BASE_TDEE,
    intake: () => BASE_TDEE,
    logged: (day) => day < ACTIVITY_CURRENT_START - 2
      || (day >= ACTIVITY_CURRENT_START - 2 && day < ACTIVITY_CURRENT_START + 2),
    steps: transitionSteps(11_200) });
}

export const ACTIVITY_SCENARIOS = {
  drop: activityDrop(),
  usual: activityUsual(),
  rise: activityRise(),
  disagreement: activityDisagreement(),
  loggingGap: activityLoggingGap(),
} as const;

export function withFalseCorroboration(scenario: Scenario): Scenario {
  const rows: DailyHealthRow[] = scenario.intake.map((day) => {
    const index = toScenarioDay(day.date);
    return {
      local_date: day.date,
      steps: index < 70 ? 8_000 : index < 78 ? null : 4_800,
      active_kcal: null,
      sleep_minutes: null,
      body_mass_kg: null,
      resting_heart_rate: null,
      hrv_sdnn: null,
      readiness_score: null,
      sources: [],
      provenance: {},
    };
  });
  return { ...scenario, label: `${scenario.label} + false step corroboration`, activityRows: rows };
}

export function steadyState(): Scenario {
  return buildScenario({ label: "steady state", seed: 1001,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE });
}

/** §4.3 claim 1a. +0.5, +1.5, +0.5 kg on three consecutive days, then gone. The 1.5 kg day is
 *  2.6 % of BASE_KG, so the outlier rule holds it out — that is the mechanism under test. */
export function waterSwing(): Scenario {
  const swing = [0.5, 1.5, 0.5];
  return buildScenario({ label: "1.5 kg water swing over 3 days", seed: 1002,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    noiseKg: 0,
    artefactKg: (d) => (d >= 70 && d < 73 ? swing[d - 70] : 0) });
}

/** Matched control for claim 1a: the exact same seed and intake noise as waterSwing(), with the
 *  artefact zeroed out. Isolates the artefact's effect from the cross-seed noise floor a
 *  comparison against the global steadyState() control would carry (ruling 10, contracts §7;
 *  see docs/estimator-backtest-2026-09-12.md). */
export function waterSwingControl(): Scenario {
  return buildScenario({ label: "1.5 kg water swing over 3 days — matched control", seed: 1002,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE, noiseKg: 0 });
}

/** §4.3 claim 1b. ±0.8 kg fluid on a 28-day period; the daily step stays under the outlier bound. */
export function cycleSwing(): Scenario {
  return buildScenario({ label: "±0.8 kg on a 28-day cycle", seed: 1003,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    noiseKg: 0,
    artefactKg: (d) => 0.8 * Math.sin((2 * Math.PI * d) / 28) });
}

/** §4.3 claim 3a. The training start: true expenditure steps +250 kcal/day, intake does not move. */
export function trainingStep(): Scenario {
  return buildScenario({ label: "+250 kcal/day step", seed: 1004,
    tdee: (d) => BASE_TDEE + (d >= 60 ? 250 : 0), intake: () => BASE_TDEE });
}

/** §4.3 claim 3b. A +15 kcal/day/week ramp, i.e. 15/7 kcal per day per day. */
export function rampUp(): Scenario {
  return buildScenario({ label: "+15 kcal/day/week ramp", seed: 1005,
    tdee: (d) => BASE_TDEE + (d >= 60 ? ((d - 60) * 15) / 7 : 0), intake: () => BASE_TDEE });
}

/** §4.3 claim 2. From day 80 the user logs three days a week. */
export function underLogging(): Scenario {
  return buildScenario({ label: "under-logging: 3 qualified days a week", seed: 1006,
    tdee: () => BASE_TDEE, intake: () => BASE_TDEE,
    logged: (d) => d < 80 || d % 7 < 3 });
}

export const SCENARIOS: readonly Scenario[] = [
  steadyState(), waterSwing(), cycleSwing(), trainingStep(), rampUp(), underLogging(),
];

export type ReplayRun = { date: string; result: ExpenditureResult };

/**
 * Run the nightly job over the whole series, one night at a time. exp-3.0.0 is stateless: every
 * night is recomputed from the inputs, so nothing is carried forward between runs.
 */
export function replayScenario(
  scenario: Scenario, opts: {
    seedKcal?: number;
    bmrKcal?: number;
    from?: number;
    marksStartedOn?: string | null;
  } = {},
): ReplayRun[] {
  const seedKcal = opts.seedKcal ?? PRIOR_KCAL;
  const bmrKcal = opts.bmrKcal ?? BMR_KCAL;
  const first = opts.from ?? 1;
  const runs: ReplayRun[] = [];
  const end = toDayNumber(scenario.asOf);

  for (let day = toDayNumber(START_DATE) + first; day <= end; day += 1) {
    const asOf = fromDayNumber(day);
    const activityContext = scenario.activityRows
      ? summarizeActivity(scenario.activityRows, asOf, "UTC")
      : undefined;
    const result = estimateExpenditure({ asOf, seedKcal, bmrKcal,
      marksStartedOn: opts.marksStartedOn ?? null,
      weighIns: scenario.weighIns.filter((w) => toDayNumber(w.date) < day),
      intake: scenario.intake.filter((i) => toDayNumber(i.date) < day),
      activityContext });
    runs.push({ date: asOf, result });
  }
  return runs;
}
