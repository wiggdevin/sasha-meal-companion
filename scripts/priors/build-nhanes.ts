/**
 * The NHANES-derived half of the W1b build (Phase 18 D8 part 1, D10): the Day 1 panel, the
 * crosswalk audit, the nested holdouts, the fairness audit, the Day 2 sensitivity, the final adult
 * table and its manifest summary. build.ts calls it only while the NCHS gate is open; nothing here
 * runs, and nothing it computes is written, otherwise. Offline build only.
 */
import { MIN_EFFECTIVE_N, PRIOR_COHORTS, type PriorRow } from "@/lib/foods/universe/prior";
import type { PriorsManifest } from "@/lib/foods/universe/artifact-schema";
import { roundRate } from "@/scripts/priors/artifact-io";
import type { createExpander, createMatcher } from "@/scripts/priors/crosswalk";
import { fairnessAudit } from "@/scripts/priors/fairness";
import {
  calibrationOf, foldsFor, FOLDS, innerFitM, liftOf, MS, rankedFrom, runHoldout, summarizeRun,
} from "@/scripts/priors/holdout";
import { emptyPerRespondent, scoreRespondents, summarize } from "@/scripts/priors/metrics";
import { loadDay } from "@/scripts/priors/nhanes";
import { buildPanel, estimateRates, GRAMS_THRESHOLD, JEFFREYS, predictionTable, type Panel, type Rates } from "@/scripts/priors/panel";
import { mappingAudit, type BuildReport } from "@/scripts/priors/report";

export const POPULATION = "U.S. adults 18 and over" as const;
const adult = (panel: Panel) => (i: number) => panel.adult[i] === 1;
const round = (value: number) => Math.round(value * 1e6) / 1e6;

function finalRows(panel: Panel, rates: Rates, m: number, sexAge: boolean, ranked: ReadonlySet<number>): PriorRow[] {
  const table = predictionTable(rates, sexAge ? m : null);
  const F = panel.foods.length;
  const rows: PriorRow[] = [];
  PRIOR_COHORTS.forEach((cohort, c) => {
    if (c > 0 && !sexAge) return;
    for (let f = 0; f < F; f += 1) {
      const nEff = rates.nEff[c * F + f];
      if (!ranked.has(f) || nEff < MIN_EFFECTIVE_N) continue;
      rows.push({ cohort, food_key: panel.foods[f], rate: roundRate(table[c * F + f]), n_eff: Math.floor(nEff) });
    }
  });
  return rows.sort((a, b) => PRIOR_COHORTS.indexOf(a.cohort) - PRIOR_COHORTS.indexOf(b.cohort) || a.food_key.localeCompare(b.food_key));
}

function effectiveCounts(rows: readonly PriorRow[]) {
  return Object.fromEntries(PRIOR_COHORTS.filter((cohort) => rows.some((row) => row.cohort === cohort)).map((cohort) => {
    const counts = rows.filter((row) => row.cohort === cohort).map((row) => row.n_eff).sort((a, b) => a - b);
    return [cohort, { cells: counts.length, min: counts[0], median: counts[counts.length >> 1], max: counts[counts.length - 1] }];
  }));
}

/** Day 1 against Day 2 adult root rates over the ranked foods: mean absolute difference and Spearman. */
function rateAgreement(day1: Rates, day2: Rates, ranked: ReadonlySet<number>) {
  const foods = [...ranked];
  const rank = (values: number[]) => {
    const out = new Array<number>(values.length);
    values.map((value, i) => [value, i] as const).sort((a, b) => a[0] - b[0]).forEach(([, i], position) => { out[i] = position; });
    return out;
  };
  const a = foods.map((f) => day1.rate[f]), b = foods.map((f) => day2.rate[f]);
  const ra = rank(a), rb = rank(b), n = foods.length;
  const d2 = ra.reduce((sum, value, i) => sum + (value - rb[i]) ** 2, 0);
  return { foods: n, meanAbsDiff: a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / n,
    spearman: 1 - (6 * d2) / (n * (n * n - 1)) };
}

export type NhanesBuild = { rows: PriorRow[]; summary: NonNullable<PriorsManifest["nhanes"]>;
  report: Omit<BuildReport, "manifest" | "sizes" | "budget" | "graph" | "representative"> };

export function buildNhanes(workspace: string, foods: readonly string[],
  expanders: readonly ReturnType<typeof createExpander>[], match: ReturnType<typeof createMatcher>): NhanesBuild {
  const expand = (release: number, code: string) => expanders[release].expand(code);
  const day1 = loadDay(workspace, 1);
  const panel = buildPanel(day1.respondents, day1.clusters, foods, expand);
  const mapping = mappingAudit(day1.respondents.filter((item) => item.age >= 18), expanders, match, foods);
  const full = estimateRates(panel, adult(panel));
  const ranked = rankedFrom(full);

  const clusterFolds = foldsFor(panel, "cluster");
  const cluster = runHoldout(panel, clusterFolds);
  const respondent = runHoldout(panel, foldsFor(panel, "respondent"));
  const shipFit = innerFitM(panel, clusterFolds, Array.from({ length: FOLDS }, (_, k) => k));
  const lift = liftOf(panel, cluster.perModel.sexage_pooled, cluster.perModel.national_pooled);
  const liftRelease = liftOf(panel, cluster.perModel.sexage_release, cluster.perModel.national_release);
  const liftRespondent = liftOf(panel, respondent.perModel.sexage_pooled, respondent.perModel.national_pooled);
  const liftAdultRoot = liftOf(panel, cluster.perModel.national_pooled, cluster.perModel.national_all_ages);
  const fairness = fairnessAudit(panel, cluster.perModel.national_pooled, cluster.perModel.sexage_pooled);
  const reasons: string[] = [];
  if (!(lift.lo > 0)) reasons.push(`cluster-bootstrap lower bound of the NDCG@5 gain is ${lift.lo.toFixed(4)}, not above 0`);
  if (!lift.signsAgree) reasons.push("the gain's sign differs between 2017-2020 and 2021-2023 (mode-change check)");
  if (!fairness.pass) reasons.push("the offline fairness audit fails its gate (docs/priors/w1b-fairness-audit.md)");
  const sexAge = reasons.length === 0;
  const shipped = sexAge ? "sexage_pooled" : "national_pooled";
  const calibration = calibrationOf(panel, cluster, shipped);

  const day2 = loadDay(workspace, 2);
  const panel2 = buildPanel(day2.respondents, day2.clusters, foods, expand);
  const day2Scores = ([["national_pooled", null], ["sexage_pooled", shipFit.m]] as const).map(([model, value]) => {
    const out = emptyPerRespondent(panel2.n);
    scoreRespondents(panel2, predictionTable(full, value), ranked, adult(panel2), out, null, 0);
    return { model, summary: summarize(panel2, out, adult(panel2)) };
  });

  const rows = finalRows(panel, full, shipFit.m, sexAge, ranked);
  const summary: NhanesBuild["summary"] = {
    population: POPULATION,
    coefficients: { gramsThreshold: GRAMS_THRESHOLD, minEffectiveN: MIN_EFFECTIVE_N, rootPrior: `Beta(${JEFFREYS}, ${JEFFREYS})`,
      shrinkage: shipFit.m, shrinkageGrid: [...MS], shrinkageByFold: cluster.mByFold,
      pooling: "each release's Day 1 dietary sample design, divided by 2 releases",
      cohorts: sexAge ? "national and sex by age" : "national only", sexAgeEnabled: sexAge, sexAgeDisabledBecause: reasons },
    mapping: { coverageAllGrams: round(mapping.coverage), coverageFoodGrams: round(mapping.foodCoverage),
      byRelease: { "2017-2020": mapping.byRelease["2017-2020"], "2021-2023": mapping.byRelease["2021-2023"] },
      mappedKeys: mapping.mappedKeys, universeKeys: foods.length, rankedKeys: ranked.size, matches: mapping.matchCounts },
    effectiveCounts: effectiveCounts(rows),
    calibration: { model: shipped, holdout: "cluster", brier: round(calibration.brier), ece: round(calibration.ece),
      eceDecile: round(calibration.eceDecile) },
    reports: { holdout: "docs/priors/w1b-holdout-report.md", fairness: "docs/priors/w1b-fairness-audit.md",
      crosswalk: "docs/priors/w1b-crosswalk-audit.md" },
    fairnessAuditPass: fairness.pass,
  };
  const report: NhanesBuild["report"] = { mapping, byM: shipFit.byM, m: shipFit.m, mByFold: cluster.mByFold,
    mByFoldRespondent: respondent.mByFold, rankedByFold: cluster.rankedByFold,
    cluster: summarizeRun(panel, cluster), respondent: summarizeRun(panel, respondent), lift, liftRelease, liftRespondent,
    liftAdultRoot, sexAge, reasons, calibration, calibrationNational: calibrationOf(panel, cluster, "national_pooled"),
    calibrationAllAges: calibrationOf(panel, cluster, "national_all_ages"), day2: day2Scores,
    day2Agreement: rateAgreement(full, estimateRates(panel2, adult(panel2)), ranked), fairness,
    respondents: { day1: panel.n, adults: panel.adult.reduce((sum, value) => sum + value, 0),
      day2: panel2.adult.reduce((sum, value) => sum + value, 0), clusters: panel.clusters.length } };
  return { rows, summary, report };
}
