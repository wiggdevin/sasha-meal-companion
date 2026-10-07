/**
 * The U.S. population prior (Phase 18 D8 part 1, D10, slice W1b): the aggregate table's contract,
 * its cohort keys and the centred, capped prior `P_f` a food gets within its plate part.
 *
 * The table is aggregate only (hard rules H1–H5): rows `{ cohort, food_key, rate, n_eff }`, one per
 * cohort and universe food, with `rate` the shrunk survey-weighted share of people who ate at least
 * 10 g of the food on a recall day and `n_eff` that cell's effective respondent count (≥ 30; smaller
 * cells are not shipped and read their parent). Cohorts are the national root (U.S. adults 18 and
 * over) and, when the build enabled them, sex by adult age band. No region or other demographic
 * axis exists (H5). Strict parsing lives in ./artifact-schema.ts.
 *
 * Neutral (`P_f = 0` for every food) when the NCHS gate is shut (lib/foods/universe/artifacts.ts),
 * when the account has not chosen the U.S. (`accountPrior`), or for a food the build could not map.
 *
 * Pure. No I/O.
 */
import type { Part } from "@/lib/meals/parts";

/** The owner's NCHS ruling. The build and the runtime load the NHANES-derived table only while it exists. */
export const NHANES_RULING_PATH = "docs/decisions/2026-10-05-nhanes-aggregate-use.md";
/**
 * sha256 of the ruling file as the owner approved it. The build emits NHANES-derived output, and
 * the runtime loads it, only while the file at NHANES_RULING_PATH hashes to this value: a refusal
 * or any edit at the same path shuts the gate until a reviewed change moves the pin.
 */
export const NHANES_RULING_SHA256 = "ba75320567a14be34538ad7564037f1660ed5db2f036dd9b3a520722dd945578";

/** The server-only artifacts (D10): the NHANES-derived table, the substitute graph, the manifest. */
export const ARTIFACT_DIR = "lib/foods/universe/artifacts";
export const PRIOR_FILE = "population-prior.json";
export const GRAPH_FILE = "substitute-graph.json";
export const MANIFEST_FILE = "priors-manifest.json";

export const PRIOR_ROW_KEYS = ["cohort", "food_key", "rate", "n_eff"] as const;
export type PriorRow = { cohort: string; food_key: string; rate: number; n_eff: number };

export const NATIONAL_COHORT = "national";
export const PRIOR_SEXES = ["female", "male"] as const;
export const PRIOR_AGE_BANDS = ["18_29", "30_39", "40_49", "50_59", "60_69", "70_plus"] as const;
/** The youngest age in each band of PRIOR_AGE_BANDS. */
export const PRIOR_AGE_LOWS = [18, 30, 40, 50, 60, 70] as const;
/** The national root is U.S. adults: the app is adult-facing (W1b round 2). */
export const ADULT_AGE = 18;
export const PRIOR_COHORTS: readonly string[] = [NATIONAL_COHORT,
  ...PRIOR_SEXES.flatMap((sex) => PRIOR_AGE_BANDS.map((band) => `${sex}_${band}`))];
export const MIN_EFFECTIVE_N = 30;
/** `P_f` is clipped to ±PRIOR_CAP after centring within its part (D8). */
export const PRIOR_CAP = 1.5;

export type PopulationPrior =
  | { status: "loaded"; byCohort: ReadonlyMap<string, ReadonlyMap<string, number>> }
  | { status: "neutral"; reason: NeutralReason };

export type NeutralReason = "ruling_missing" | "ruling_changed" | "manifest_invalid" | "manifest_unnamed"
  | "artifact_missing" | "artifact_invalid" | AccountNeutralReason;

/** Per-account reasons (D2): the account has not chosen the U.S. Never logged: they are not faults. */
export type AccountNeutralReason = "country_unset" | "country_not_us";

/** The one country the prior describes (NHANES is U.S. only; no other country model exists, D10). */
export const PRIOR_COUNTRY = "US";

/** The account fields the prior may read: the stored country, sex and birth year. Nothing else (D2). */
export type PriorAccount = {
  countryCode?: string | null;
  sex?: "female" | "male" | null;
  birthYear?: number | null;
};

/** The prior an account gets on a date, and its cohort. */
export type AccountPrior = { prior: PopulationPrior; cohort: string };

/** The cohort for an account: sex by age when both are known and the table has it, else national. */
export function priorCohort(prior: PopulationPrior, sex: "female" | "male" | null, age: number | null): string {
  if (prior.status !== "loaded" || !sex || age === null || !Number.isFinite(age) || age < ADULT_AGE) return NATIONAL_COHORT;
  const band = PRIOR_AGE_LOWS.reduce<number>((found, low, index) => (age >= low ? index : found), 0);
  const key = `${sex}_${PRIOR_AGE_BANDS[band]}`;
  return prior.byCohort.has(key) ? key : NATIONAL_COHORT;
}

/** Age on `onDate` (YYYY-MM-DD) from the birth year alone, or null when either is missing or invalid. */
export function ageOn(birthYear: number | null | undefined, onDate: string): number | null {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(onDate);
  if (!match || typeof birthYear !== "number" || !Number.isInteger(birthYear)) return null;
  const age = Number(match[1]) - birthYear;
  return age >= 0 ? age : null;
}

/**
 * D2 and D8: the prior an account gets. Neutral (`P_f = 0`) unless the account chose the U.S.
 * (`country_code = 'US'`); a missing or other country never falls back to the U.S. table, and the
 * country is never inferred from a time zone or location. A U.S. account gets `loaded` as given:
 * the NCHS gate has already decided it (lib/foods/universe/artifacts.ts), so a shut gate stays
 * neutral here too. Its cohort is sex by adult age band from the stored sex and the birth year on
 * `onDate` when the table carries that cohort, else the national root (W1b ships national only).
 */
export function accountPrior(loaded: PopulationPrior, account: PriorAccount, onDate: string): AccountPrior {
  const country = account.countryCode ?? null;
  if (country !== PRIOR_COUNTRY) {
    return { prior: { status: "neutral", reason: country === null ? "country_unset" : "country_not_us" },
      cohort: NATIONAL_COHORT };
  }
  const sex = account.sex === "female" || account.sex === "male" ? account.sex : null;
  return { prior: loaded, cohort: priorCohort(loaded, sex, ageOn(account.birthYear, onDate)) };
}

export function priorFromRows(rows: readonly PriorRow[]): PopulationPrior {
  const byCohort = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const cohort = byCohort.get(row.cohort) ?? new Map<string, number>();
    cohort.set(row.food_key, row.rate);
    byCohort.set(row.cohort, cohort);
  }
  return byCohort.has(NATIONAL_COHORT) ? { status: "loaded", byCohort } : { status: "neutral", reason: "artifact_invalid" };
}

const logit = (p: number) => Math.log(p / (1 - p));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `P_f = clip(logit(p_{c,f}) − median_{g in f's part} logit(p_{c,g}), −1.5, 1.5)` for every food in
 * `parts` (its first part decides the comparison group). A cohort cell the table lacks reads the
 * national value; a food with neither, or any food under a neutral prior, gets 0.
 */
export function priorScores(prior: PopulationPrior, cohort: string,
  parts: Readonly<Record<string, readonly Part[]>>): Record<string, number> {
  const keys = Object.keys(parts).sort();
  const out: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  if (prior.status !== "loaded") return out;
  const national = prior.byCohort.get(NATIONAL_COHORT)!;
  const own = prior.byCohort.get(cohort) ?? national;
  const rateOf = (key: string) => own.get(key) ?? national.get(key);
  const groups = new Map<Part, string[]>();
  for (const key of keys) {
    const part = parts[key][0];
    if (part && rateOf(key) !== undefined) groups.set(part, [...(groups.get(part) ?? []), key]);
  }
  for (const members of groups.values()) {
    const centre = median(members.map((key) => logit(rateOf(key)!)));
    for (const key of members) out[key] = Math.max(-PRIOR_CAP, Math.min(PRIOR_CAP, logit(rateOf(key)!) - centre));
  }
  return out;
}
