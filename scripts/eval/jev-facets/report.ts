import {
  BATCH_TOKEN_LIMIT,
  SPEND_LIMIT_USD,
  costUsd,
  type ActionThresholds,
  type Matrix,
  type Observation,
  type Usage,
} from "./types";
import { matrix, rates, ratio } from "./scoring";

const CANDIDATES = [0.5, 0.7, 0.8, 0.9, 0.95, 0.99] as const;
export const HOLDOUT_NEGATIVE_FLOOR = 5;

export function reportSource(observed: Record<string, Observation[]>,
  thresholds: Record<string, ActionThresholds>, model: string, usage: Usage,
  counts: { dev: number; holdout: number; operational: number; privacy: number }):
  { markdown: string; passing: boolean } {
  const spend = costUsd(usage);
  const keys = Object.keys(observed);
  let passing = keys.every((key) => thresholds[key]);
  const facetF1 = keys.filter((key) => !key.startsWith("portion:")).map((key) => {
    const r = rates(matrix(holdout(observed[key]), thresholds[key].exclude));
    return ratio(2 * r.precision * r.recall, r.precision + r.recall);
  });
  const macroF1 = ratio(facetF1.reduce((sum, value) => sum + value, 0), facetF1.length);
  const lines = ["# Jev food-facet evaluation — 2026-09-20", "",
    `- DEV ${counts.dev}; HOLDOUT ${counts.holdout}; the splits are judged in separate requests.`,
    `- Rubric 1; served model: \`${model}\`.`,
    `- Live refresh usage this run: ${usage.inputTokens.toLocaleString()} input + ${usage.outputTokens.toLocaleString()} output tokens across ${usage.requests} requests; spend: **$${spend.toFixed(6)}** (< $2; output rate $0/MTok).`,
    `- Batch ceiling: ≤ ${BATCH_TOKEN_LIMIT.toLocaleString()} serialized-token estimate per request.`,
    `- Operational fixtures skipped (not sent or fitted): ${counts.operational}; privacy canaries checked: ${counts.privacy}.`,
    `- Informational HOLDOUT macro-F1 at frozen exclude thresholds: ${macroF1.toFixed(3)} (not a launch gate).`,
    "- Calibration cells are `bin-start:n/mean-p/empirical-positive-rate`.", "",
    "## Frozen thresholds and HOLDOUT", "",
    "| Question | Action | absent / present | TP FP TN FN U+ U- | precision | recall | FPR | coverage |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const key of keys) for (const action of ["mark", "exclude"] as const) {
    const pair = thresholds[key][action];
    const m = matrix(holdout(observed[key]), pair);
    const r = rates(m);
    if (action === "exclude" && r.fpr > 0.05) passing = false;
    lines.push(row(key, action, pair, m, r));
  }
  lines.push("", "## DEV candidate thresholds", "", "| Question | precision / recall / FPR by threshold |", "|---|---|");
  for (const key of keys) lines.push(`| ${key} | ${CANDIDATES.map((t) => metric(observed[key], t)).join("; ")} |`);
  lines.push("", "## HOLDOUT calibration", "", "| Question | bins |", "|---|---|");
  for (const key of keys) lines.push(`| ${key} | ${calibration(holdout(observed[key]))} |`);
  const weak = keys.filter((key) => {
    const r = rates(matrix(holdout(observed[key]), thresholds[key].exclude));
    return r.recall < 0.8 || r.coverage < 0.8;
  });
  lines.push("", "## Weak numbers and recommendation", "",
    weak.length === 0
      ? "No HOLDOUT question fell below 0.80 recall or 0.80 coverage."
      : `${weak.map((key) => `\`${key}\``).join(", ")} fell below 0.80 recall or coverage. Keep unknown as unverified and do not tune on HOLDOUT.`,
    "", "## HOLDOUT facet label coverage", "",
    `At least ${HOLDOUT_NEGATIVE_FLOOR} explicit hard negatives are required per facet; fewer cannot support an FPR claim.`, "",
    "| Facet | positive | negative | status |",
    "|---|---:|---:|---|");
  for (const key of keys.filter(isFacet)) {
    const rows = holdout(observed[key]);
    const positives = rows.filter((row) => row.truth).length;
    const negatives = rows.length - positives;
    if (negatives < HOLDOUT_NEGATIVE_FLOOR) passing = false;
    lines.push(`| ${key} | ${positives} | ${negatives} | ${negatives < HOLDOUT_NEGATIVE_FLOOR ? `below ${HOLDOUT_NEGATIVE_FLOOR}` : "covered"} |`);
  }
  lines.push("", `Gate: **${passing && spend < SPEND_LIMIT_USD ? "PASS" : "FAIL"}** — committed thresholds score every HOLDOUT exclude-action FPR at ≤ 0.05 and every facet has at least ${HOLDOUT_NEGATIVE_FLOOR} explicit hard negatives.`);
  return { markdown: `${lines.join("\n")}\n`, passing: passing && spend < SPEND_LIMIT_USD };
}

function isFacet(key: string): boolean {
  return key !== "not_human_food" && !key.startsWith("portion:");
}

function holdout(rows: Observation[]): Observation[] {
  return rows.filter((row) => row.split === "holdout");
}

function row(key: string, action: string, pair: { absent: number; present: number }, m: Matrix,
  r: ReturnType<typeof rates>): string {
  return `| ${key} | ${action} | ${pair.absent.toFixed(3)} / ${pair.present.toFixed(3)} | ${m.tp} ${m.fp} ${m.tn} ${m.fn} ${m.up} ${m.un} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.fpr.toFixed(3)} | ${r.coverage.toFixed(3)} |`;
}

function metric(rows: Observation[], threshold: number): string {
  const r = rates(matrix(rows.filter((item) => item.split === "dev"), { present: threshold, absent: -1 }));
  return `${threshold.toFixed(2)}=${r.precision.toFixed(2)}/${r.recall.toFixed(2)}/${r.fpr.toFixed(2)}`;
}

function calibration(rows: Observation[]): string {
  return [0, 0.2, 0.4, 0.6, 0.8].map((start) => {
    const bin = rows.filter((item) => item.p >= start && (start === 0.8 ? item.p <= 1 : item.p < start + 0.2));
    const mean = ratio(bin.reduce((sum, item) => sum + item.p, 0), bin.length);
    const truth = ratio(bin.filter((item) => item.truth).length, bin.length);
    return `${start.toFixed(1)}:${bin.length}/${mean.toFixed(2)}/${truth.toFixed(2)}`;
  }).join(" ");
}
