/**
 * The W1c calibration step (Phase 18 §5 "Jev pair labels", acceptance 1): raw Jev pair
 * probabilities against the independent human holdout (holdout.ts), Platt-calibrated with 5-fold
 * cross-fitting, so every calibrated probability is scored on pairs its calibrator never saw.
 * Offline build only. Labels come only from the human CSV; Jev's own answers are never a label.
 *
 *   Brier  mean (p − y)² over the labelled pairs.
 *   ECE    |mean p − observed rate| over 10 equal-width bins, weighted by the bins' share (§5).
 *   gate   calibrated Brier ≤ 0.18, calibrated ECE ≤ 0.05, and raw Brier − calibrated Brier ≥ 0.01,
 *          on at least 400 labelled pairs with a Jev label each.
 *
 *   pnpm exec tsx scripts/pairing/calibrate.ts     writes docs/pairing/w1c-calibration-report.md and
 *                                                  scripts/pairing/data/jev-calibration.json
 *
 * Until the owner's labels exist the status is `frozen` and nothing calibrated ships. The Jev weight
 * (lib/foods/pairing/table.ts PAIR_WEIGHTS.jev) stays 0 even after a pass, until the replay lift of
 * §5 passes too (W8).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACTIVATION_GATE } from "@/lib/foods/pairing/gate";
import { pairKey } from "@/lib/foods/pairing/table";
import { sha256Hex } from "@/lib/foods/sha256";
import { CUISINES } from "@/lib/foods/universe/vocabulary";
import { ece, widthBins, type CalibrationBin } from "@/scripts/priors/metrics";
import { holdoutShortfall, loadHoldout, MIN_LABELLED, type HoldoutLoad, type HumanLabel } from "@/scripts/pairing/holdout";

export const GATE = ACTIVATION_GATE;
export const FOLDS = 5;
export const CALIBRATION_FILE = "scripts/pairing/data/jev-calibration.json";
export const CALIBRATION_REPORT = "docs/pairing/w1c-calibration-report.md";

export type Platt = { a: number; b: number };
export type Scores = { brier: number; ece: number; curve: CalibrationBin[] };
export type Calibration = {
  status: "frozen" | "pass" | "fail";
  reasons: string[];
  labelled: number;
  withJev: number;
  raw: Scores | null;
  calibrated: Scores | null;
  co: Scores | null;
  platt: Platt | null;
  perCuisine: { cuisine: string; n: number; rawBrier: number; calibratedBrier: number }[];
};

const clampP = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Platt scaling, p' = σ(a·logit(p) + b), by Newton's method with a tiny ridge for stability. */
export function fitPlatt(raw: readonly number[], labels: readonly number[]): Platt {
  let a = 1, b = 0;
  const ridge = 1e-3;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let ga = ridge * (a - 1), gb = ridge * b, haa = ridge, hab = 0, hbb = ridge;
    raw.forEach((p, i) => {
      const x = logit(p), q = sigmoid(a * x + b), d = q - labels[i], w = q * (1 - q);
      ga += d * x; gb += d; haa += w * x * x; hab += w * x; hbb += w;
    });
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return { a, b };
}

export const applyPlatt = (platt: Platt, p: number) => sigmoid(platt.a * logit(p) + platt.b);

export function scores(predicted: readonly number[], labels: readonly number[]): Scores {
  const n = predicted.length;
  const brier = predicted.reduce((sum, p, i) => sum + (p - labels[i]) ** 2, 0) / n;
  const curve = widthBins({ predicted: Float64Array.from(predicted), weight: new Float64Array(n).fill(1), eaten: Float64Array.from(labels) });
  return { brier, ece: ece(curve), curve };
}

export const foldOf = (id: string) => parseInt(sha256Hex(id).slice(0, 8), 16) % FOLDS;

/** Out-of-fold calibrated probabilities: each fold is calibrated by a fit on the other four. */
export function crossFitted(rows: readonly { id: string; p: number; y: number }[]): number[] {
  const out = new Array<number>(rows.length);
  for (let fold = 0; fold < FOLDS; fold += 1) {
    const train = rows.filter((row) => foldOf(row.id) !== fold);
    const platt = fitPlatt(train.map((row) => row.p), train.map((row) => row.y));
    rows.forEach((row, i) => { if (foldOf(row.id) === fold) out[i] = applyPlatt(platt, row.p); });
  }
  return out;
}

/** The calibration of `raw` (Jev's stored probabilities by pair id) against the human labels. */
export function calibrate(load: HoldoutLoad, raw: ReadonlyMap<string, number>, co?: ReadonlyMap<string, number>): Calibration {
  const shortfall = holdoutShortfall(load);
  const rows = load.labels.filter((label) => raw.has(label.id)).map((label) => ({ id: label.id, p: raw.get(label.id)!,
    y: label.label, cuisine: label.cuisine }));
  const base = { labelled: load.labels.length, withJev: rows.length };
  const reasons = [...shortfall];
  if (rows.length < load.labels.length) reasons.push(`${load.labels.length - rows.length} labelled pairs have no stored Jev label`);
  if (reasons.length || !rows.length) {
    return { status: "frozen", reasons: reasons.length ? reasons : ["no labelled pairs"], ...base, raw: null, calibrated: null, co: null,
      platt: null, perCuisine: [] };
  }
  const labels = rows.map((row) => row.y);
  const rawScores = scores(rows.map((row) => row.p), labels);
  const fitted = crossFitted(rows);
  const calibrated = scores(fitted, labels);
  const coRows = co ? load.labels.filter((label) => co.has(label.id)) : [];
  const coScores = coRows.length ? scores(coRows.map((label) => co!.get(label.id)!), coRows.map((label) => label.label)) : null;
  const fails: string[] = [];
  if (calibrated.brier > GATE.brier) fails.push(`calibrated Brier ${calibrated.brier.toFixed(4)} > ${GATE.brier}`);
  if (calibrated.ece > GATE.ece) fails.push(`calibrated ECE ${calibrated.ece.toFixed(4)} > ${GATE.ece}`);
  if (rawScores.brier - calibrated.brier < GATE.gain) fails.push(`gain over raw ${(rawScores.brier - calibrated.brier).toFixed(4)} < ${GATE.gain}`);
  const perCuisine = CUISINES.map((cuisine) => {
    const at = rows.map((row, i) => [row, i] as const).filter(([row]) => row.cuisine === cuisine);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
    return { cuisine, n: at.length, rawBrier: mean(at.map(([row]) => (row.p - row.y) ** 2)),
      calibratedBrier: mean(at.map(([row, i]) => (fitted[i] - row.y) ** 2)) };
  });
  return { status: fails.length ? "fail" : "pass", reasons: fails, ...base, raw: rawScores, calibrated, co: coScores,
    platt: fitPlatt(rows.map((row) => row.p), labels), perCuisine };
}

const f4 = (value: number) => value.toFixed(4);
const curveTable = (curve: CalibrationBin[]) => ["| bin | share | mean p | observed |", "|---|---|---|---|",
  ...curve.map((bin) => `| ${bin.lo.toFixed(2)}–${bin.hi.toFixed(2)} | ${f4(bin.mass)} | ${f4(bin.predicted)} | ${f4(bin.observed)} |`)];

export function calibrationReport(result: Calibration, model: string, storeLabels: number): string {
  const head = ["# W1c Jev pair labels: calibration on the human holdout (acceptance 1)", "",
    `Generated by \`scripts/pairing/calibrate.ts\`. Model \`${model}\`, purpose \`pair_plausibility\`. Holdout: `
    + "`docs/pairing/holdout-pairs.csv` (432 cuisine-balanced pairs, human labels only; instructions in "
    + "`docs/pairing/holdout-instructions.md`). Stored Jev labels: " + `${storeLabels}.`, "",
    `Gate (§5): calibrated Brier ≤ ${GATE.brier}, ECE ≤ ${GATE.ece}, at least ${GATE.gain} Brier better than raw, on ≥ ${MIN_LABELLED} labelled pairs.`,
    "", `**Status: ${result.status.toUpperCase()}.** Labelled pairs: ${result.labelled}; with a stored Jev label: ${result.withJev}.`, ""];
  if (result.status === "frozen") {
    return [...head, "Nothing is calibrated and nothing Jev-derived ships. Why:", "", ...result.reasons.map((reason) => `- ${reason}`), "",
      "The owner fills the holdout CSV by hand; then `jev-labels.ts --items holdout --max-usd 0.05` stores Jev's raw labels for",
      "the same pairs and this script reruns. The Jev weight stays 0 until this gate and the §5 replay lift both pass.", ""].join("\n");
  }
  const rows = [["raw Jev", result.raw!], ["calibrated (5-fold cross-fitted Platt)", result.calibrated!],
    ...(result.co ? [["co-consumption feature (informative)", result.co] as const] : [])] as const;
  return [...head, "| probabilities | Brier | ECE |", "|---|---|---|",
    ...rows.map(([name, value]) => `| ${name} | ${f4(value.brier)} | ${f4(value.ece)} |`), "",
    `Platt fit on every labelled pair: a = ${f4(result.platt!.a)}, b = ${f4(result.platt!.b)}.`, "",
    ...(result.reasons.length ? ["Gate failures:", "", ...result.reasons.map((reason) => `- ${reason}`), ""] : ["The gate passes.", ""]),
    "## Reliability, raw", "", ...curveTable(result.raw!.curve), "", "## Reliability, calibrated", "", ...curveTable(result.calibrated!.curve), "",
    "## By cuisine", "", "| cuisine | n | raw Brier | calibrated Brier |", "|---|---|---|---|",
    ...result.perCuisine.map((row) => `| ${row.cuisine} | ${row.n} | ${f4(row.rawBrier)} | ${f4(row.calibratedBrier)} |`), ""].join("\n");
}

/** The stored calibration the build reads: the status, and the Platt fit only on a pass. */
export function storedCalibration(result: Calibration, model: string) {
  return { status: result.status, reasons: result.reasons, model, labelled: result.labelled, withJev: result.withJev,
    platt: result.status === "pass" ? result.platt : null };
}

async function main(): Promise<void> {
  const [{ LANES }, { fixedPairs, holdoutCandidates, toItem }, { readStore, labelsFor }, { readCoFeatures }] = await Promise.all([
    import("@/lib/ai/lanes"), import("@/scripts/pairing/pairs"), import("@/scripts/pairing/labels"),
    import("@/scripts/pairing/artifact-io")]);
  const model = LANES.judge.model;
  const candidates = holdoutCandidates(fixedPairs());
  const load = loadHoldout(candidates);
  const store = readStore();
  const raw = labelsFor(store, candidates.map(toItem), model);
  const coByKey = readCoFeatures();
  const co = new Map(candidates.flatMap((pair) => {
    const value = coByKey.get(pairKey(pair.anchor, pair.side, pair.template));
    return value === undefined ? [] : [[pair.id, value] as const];
  }));
  const result = calibrate(load, raw, co);
  writeFileSync(CALIBRATION_REPORT, calibrationReport(result, model, store.labels.length));
  writeFileSync(CALIBRATION_FILE, `${JSON.stringify(storedCalibration(result, model), null, 2)}\n`);
  console.log(`calibration ${result.status}: ${result.reasons.slice(0, 3).join("; ")}${result.reasons.length > 3 ? " …" : ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();

export type { HumanLabel };
