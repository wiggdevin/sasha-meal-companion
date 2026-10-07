/**
 * The W1b reports under docs/priors/ (aggregate numbers only): the respondent and cluster holdout
 * report, the offline fairness audit, and the FNDDS-to-universe crosswalk audit. Offline build only.
 * Nothing in them is per person: every number is a weighted mean, a share of all recalled grams, or
 * a count of respondents in a group of thousands. No timestamp, so the same inputs give the same text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubstituteGraph } from "@/lib/foods/universe/substitutes";
import type { Leaf, Match } from "@/scripts/priors/crosswalk";
import { DRINK } from "@/scripts/priors/crosswalk";
import type { FairnessResult } from "@/scripts/priors/fairness";
import { GAP_GROWTH_MAX, GROUP_DROP_MAX } from "@/scripts/priors/fairness";
import type { Calibration, Lift, ModelReport } from "@/scripts/priors/holdout";
import { RELEASE_LABELS } from "@/scripts/priors/holdout";
import type { Summary } from "@/scripts/priors/metrics";
import type { Respondent } from "@/scripts/priors/nhanes";
import { renderCrosswalk, renderFairness } from "@/scripts/priors/report-extra";

export type MappingAudit = {
  coverage: number; foodCoverage: number; byRelease: Record<string, number>; mappedKeys: number;
  matchCounts: Record<"exact" | "family" | "loose", number>;
  unmapped: { description: string; share: number; drink: boolean }[];
  ties: { description: string; keys: string[]; share: number }[];
  loose: { description: string; keys: string[]; share: number; jaccard: number }[];
  neverMapped: string[];
};

type Expanders = readonly { leaves: (code: string) => Leaf[] }[];

/** Shares of all Day 1 recalled grams (pooled weights), by leaf ingredient. */
export function mappingAudit(respondents: readonly Respondent[], expanders: Expanders,
  match: (ingredient: Leaf["ingredient"]) => Match | null, universeKeys: readonly string[]): MappingAudit {
  const byCode = expanders.map(() => new Map<string, number>());
  for (const item of respondents) for (const [code, grams] of item.foods) {
    byCode[item.release].set(code, (byCode[item.release].get(code) ?? 0) + item.weight * grams);
  }
  const unmapped = new Map<string, number>(), ties = new Map<string, { keys: string[]; share: number }>();
  const loose = new Map<string, { keys: string[]; share: number; jaccard: number }>();
  const keyed = new Set<string>();
  const counts = { exact: 0, family: 0, loose: 0 };
  let total = 0, mapped = 0, drink = 0;
  const byRelease: Record<string, number> = {};
  byCode.forEach((codes, release) => {
    let releaseTotal = 0, releaseMapped = 0;
    for (const [code, grams] of [...codes].sort((a, b) => a[0].localeCompare(b[0]))) {
      total += grams; releaseTotal += grams;
      for (const leaf of expanders[release].leaves(code)) {
        const amount = grams * leaf.share;
        const found = match(leaf.ingredient);
        const name = leaf.ingredient.description;
        if (!found) {
          unmapped.set(name, (unmapped.get(name) ?? 0) + amount);
          if (DRINK.test(name)) drink += amount;
          continue;
        }
        mapped += amount; releaseMapped += amount; counts[found.how] += amount;
        found.keys.forEach((key) => keyed.add(key));
        if (found.keys.length > 1) ties.set(name, { keys: found.keys, share: (ties.get(name)?.share ?? 0) + amount });
        if (found.how === "loose") loose.set(name, { keys: found.keys, jaccard: found.jaccard, share: (loose.get(name)?.share ?? 0) + amount });
      }
    }
    byRelease[RELEASE_LABELS[release]] = round(releaseMapped / releaseTotal);
  });
  const top = <T extends { share: number }>(entries: [string, T][], limit: number) => entries
    .map(([description, value]) => ({ description, ...value, share: value.share / total }))
    .sort((a, b) => b.share - a.share || a.description.localeCompare(b.description)).slice(0, limit);
  return {
    coverage: mapped / total, foodCoverage: mapped / (total - drink), byRelease, mappedKeys: keyed.size,
    matchCounts: { exact: round(counts.exact / total), family: round(counts.family / total), loose: round(counts.loose / total) },
    unmapped: top([...unmapped].map(([name, share]) => [name, { share, drink: DRINK.test(name) }]), 60),
    ties: top([...ties], 40), loose: top([...loose], 80),
    neverMapped: universeKeys.filter((key) => !keyed.has(key)),
  };
}

export type BuildReport = {
  manifest: { artifactHash: string; coefficientVersion: string; universe: { version: string };
    graph: { context: { dishes: number; foods: number } } };
  mapping: MappingAudit; byM: { m: number; ndcg5: number; brier: number }[]; m: number;
  mByFold: number[]; mByFoldRespondent: number[]; rankedByFold: number[];
  cluster: ModelReport[]; respondent: ModelReport[]; lift: Lift; liftRelease: Lift; liftRespondent: Lift;
  liftAdultRoot: Lift; sexAge: boolean; reasons: string[]; calibration: Calibration; calibrationNational: Calibration;
  calibrationAllAges: Calibration;
  day2: { model: string; summary: Summary }[]; day2Agreement: { foods: number; meanAbsDiff: number; spearman: number };
  fairness: FairnessResult; sizes: { prior: number; graph: number; manifest: number }; budget: number;
  respondents: { day1: number; adults: number; day2: number; clusters: number }; graph: SubstituteGraph; representative: number;
};

/** The NHANES-derived reports: written only while the NCHS gate is open, removed otherwise. */
export const REPORT_FILES = ["w1b-holdout-report.md", "w1b-fairness-audit.md", "w1b-crosswalk-audit.md"]
  .map((name) => ["docs", "priors", name].join("/"));

const round = (value: number) => Math.round(value * 1e6) / 1e6;
export const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)} %`;
const f4 = (value: number) => value.toFixed(4);

const MODEL_LABEL: Record<string, string> = {
  neutral: "Neutral (no prior)", national_all_ages: "National, all ages 2+ (round 1 root)", national_pooled: "National adults, pooled", national_release: "National adults, release-specific",
  sexage_pooled: "Sex by age, pooled", sexage_release: "Sex by age, release-specific",
};

function modelTable(rows: readonly ModelReport[]): string[] {
  return ["| Model | Scope | Respondents ranked | hit@3 | hit@10 | NDCG@5 | Brier |", "|---|---|---|---|---|---|---|",
    ...rows.map(({ model, scope, summary }) => `| ${MODEL_LABEL[model]} | ${scope} | ${summary.ranked} of ${summary.respondents} `
      + `| ${f4(summary.hit3)} | ${f4(summary.hit10)} | ${f4(summary.ndcg5)} | ${f4(summary.brier)} |`)];
}

function liftLine(name: string, lift: Lift): string {
  return `| ${name} | ${f4(lift.gain)} | ${f4(lift.lo)} to ${f4(lift.hi)} | `
    + `${RELEASE_LABELS.map((label) => f4(lift.byRelease[label])).join(" / ")} | ${lift.signsAgree ? "yes" : "no"} |`;
}

function calibrationTable(calibration: Calibration): string[] {
  return ["| Decile | Predicted p range | Mass | Mean predicted | Observed |", "|---|---|---|---|---|",
    ...calibration.deciles.map((bin, i) => `| ${i + 1} | ${bin.lo.toFixed(4)} to ${bin.hi.toFixed(4)} | ${pct(bin.mass)} `
      + `| ${bin.predicted.toFixed(4)} | ${bin.observed.toFixed(4)} |`)];
}

function holdout(r: BuildReport): string {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
  const totalGzip = r.sizes.prior + r.sizes.graph + r.sizes.manifest;
  return [
    "# W1b population prior: holdout report", "",
    "Generated by `scripts/priors/build.ts` (Phase 18 W1b, acceptance 2 and 3). Aggregate numbers only.",
    `Coefficient version \`${r.manifest.coefficientVersion}\`, universe ${r.manifest.universe.version}, artifact hash`,
    `\`${r.manifest.artifactHash}\`.`, "",
    "## Data", "",
    `Day 1: ${r.respondents.adults} adults aged 18 and over (the shipped root's population; ${r.respondents.day1} respondents`,
    `aged 2 and over for the all-ages comparison) with a reliable recall and a positive day weight, in`,
    `${r.respondents.clusters} survey PSUs, from 2017-March 2020 and August 2021-August 2023, each release with its own`,
    "dietary weights divided by 2. A food is eaten when the respondent ate at least 10 g of it that day, after expanding",
    "each recalled FNDDS food through its documented ingredients (an estimate of a dish, not the respondent's recipe).",
    `Day 2 (sensitivity only): ${r.respondents.day2} adults. Mapping coverage (adult recalls): ${pct(r.mapping.coverage)} of all recalled grams`,
    `(${pct(r.mapping.foodCoverage)} excluding unmapped drinks, which D1 keeps out of the universe); see`,
    "`w1b-crosswalk-audit.md`.", "",
    "## Metrics", "",
    "Per respondent, the foods with a national estimate are ranked by the respondent's cohort prediction. hit@k is 1",
    "when any of the top k was eaten; NDCG@5 uses binary relevance; Brier averages (p - y)^2 over the ranked foods. All",
    "means are weighted by the dietary weight. Neutral is the expectation under a random order (Brier: one constant).",
    "Only adults are scored. No scoring fold informs its own scores: its ranked food set comes from its training folds",
    `(${r.rankedByFold.join(", ")} foods per cluster fold), and its m is chosen by leave-one-fold-out inside its training`,
    "folds (nested CV). Calibration is fold-matched: each observation is binned with the prediction that scored it.",
    "", "## Cluster holdout (5 folds of survey PSUs)", "", ...modelTable(r.cluster), "",
    "## Respondent holdout (5 folds of respondents)", "", ...modelTable(r.respondent), "",
    "## Shrinkage weight m", "",
    `Nested CV picked m = ${r.mByFold.join(", ")} for the five cluster folds and ${r.mByFoldRespondent.join(", ")} for the five`,
    "respondent folds. For a shipped sex by age table, m is chosen by leave-one-fold-out over all five cluster folds:", "",
    "| m | NDCG@5 | Brier |", "|---|---|---|", ...r.byM.map((row) => `| ${row.m} | ${f4(row.ndcg5)} | ${f4(row.brier)} |`), "",
    `Chosen m = ${r.m} (best NDCG@5; ties to the larger m).`, "",
    "## Adult root (18+) against the all-ages root (2+), scored on adults", "",
    "| Comparison | Gain | 95 % cluster bootstrap | Gain 2017-2020 / 2021-2023 | Same sign |", "|---|---|---|---|---|",
    liftLine("Adult root over all-ages root, cluster holdout", r.liftAdultRoot), "",
    `Calibration on adults: adult root Brier ${f4(r.calibrationNational.brier)}, ECE ${f4(r.calibrationNational.ece)}; `
      + `all-ages root Brier ${f4(r.calibrationAllAges.brier)}, ECE ${f4(r.calibrationAllAges.ece)}.`, "",
    "## Sex by age: lift over the national root (NDCG@5)", "",
    "| Comparison | Gain | 95 % cluster bootstrap | Gain 2017-2020 / 2021-2023 | Same sign |", "|---|---|---|---|---|",
    liftLine("Pooled, cluster holdout", r.lift), liftLine("Release-specific, cluster holdout", r.liftRelease),
    liftLine("Pooled, respondent holdout", r.liftRespondent), "",
    r.sexAge ? "**Sex by age is enabled**: the lower bound is above 0, the sign holds in both releases (the mode-change "
      + "check: 2021-2023 Day 1 moved to the telephone), and the fairness audit passes."
      : `**Sex by age is disabled**: ${r.reasons.join("; ")}. The shipped table is the national root only.`, "",
    `Cells under 30 effective respondents are not shipped; such a cell reads its parent (the national root).`, "",
    "## Calibration of the shipped model (cluster holdout)", "",
    `Brier ${f4(r.calibration.brier)}; ECE (10 equal-width bins) ${f4(r.calibration.ece)}; ECE by decile ${f4(r.calibration.eceDecile)}.`,
    `National-only reference: Brier ${f4(r.calibrationNational.brier)}, ECE ${f4(r.calibrationNational.ece)}.`, "",
    ...calibrationTable(r.calibration), "",
    "## Day 2 sensitivity (not used to fit or enable anything)", "",
    "Models fitted on all adult Day 1 recalls, scored on adult Day 2 recalls with the Day 2 weights.", "",
    "| Model | Respondents ranked | hit@3 | hit@10 | NDCG@5 | Brier |", "|---|---|---|---|---|---|",
    ...r.day2.map(({ model, summary }) => `| ${MODEL_LABEL[model]} | ${summary.ranked} of ${summary.respondents} | ${f4(summary.hit3)} `
      + `| ${f4(summary.hit10)} | ${f4(summary.ndcg5)} | ${f4(summary.brier)} |`), "",
    `Adult root Day 1 against Day 2 rates over ${r.day2Agreement.foods} foods: mean absolute difference `
      + `${f4(r.day2Agreement.meanAbsDiff)}, Spearman ${r.day2Agreement.spearman.toFixed(3)}.`, "",
    "## Substitute graph", "",
    `${r.graph.edges.length} edges over ${new Set(r.graph.edges.map((edge) => edge.from)).size} foods (at most 8 per food, same plate part,`,
    `sub >= 0.2). Terms present: tax (SR food group and FNDDS code hierarchy; ${r.representative} foods have a representative`,
    `FNDDS code), nutr and ctx (FNDDS 2021-2023 dish ingredient lists: ${r.manifest.graph.context.dishes} dishes, `
      + `${r.manifest.graph.context.foods} foods with context; ${r.graph.edges.filter((edge) => edge.ctx !== undefined).length} `
      + `edges carry it). Absent: ${r.graph.absent.join(", ")} (see the manifest's withheld sources).`, "",
    "## Artifact size (gzip -9)", "",
    `Population prior ${kb(r.sizes.prior)}, substitute graph ${kb(r.sizes.graph)}, manifest ${kb(r.sizes.manifest)}: `
      + `${kb(totalGzip)} against the ${kb(r.budget)} budget (${totalGzip <= r.budget ? "within" : "OVER"}).`, "",
  ].join("\n");
}

export function writeReports(root: string, report: BuildReport): void {
  const dir = join(root, "docs", "priors");
  mkdirSync(dir, { recursive: true });
  const [holdoutFile, fairnessFile, crosswalkFile] = REPORT_FILES;
  writeFileSync(join(root, holdoutFile), holdout(report));
  writeFileSync(join(root, fairnessFile), renderFairness(report.fairness, report.sexAge, GROUP_DROP_MAX, GAP_GROWTH_MAX));
  writeFileSync(join(root, crosswalkFile), renderCrosswalk(report.mapping));
}
