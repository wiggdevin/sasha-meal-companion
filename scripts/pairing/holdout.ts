/**
 * The human pair holdout for the Jev pair labels (Phase 18 §5 "Jev pair labels", W1c acceptance 1):
 * the blinded labelling template and its loader. Offline build only.
 *
 * The template (docs/pairing/holdout-pairs.csv) lists the 432 cuisine-balanced candidates
 * (pairs.ts `holdoutCandidates`, 36 per cuisine) with the stated occasion and the catalog names,
 * and nothing else: no curated score, no Jev probability, no co-consumption rate (blinded). A person
 * fills `label` (yes, no or unsure) and `labeller` (their initials) by hand, following
 * docs/pairing/holdout-instructions.md.
 *
 * The loader refuses a file it cannot trust: a changed header, a pair that is not a candidate or
 * whose names were edited, a label outside yes/no/unsure, a labelled row with no labeller, or a
 * labeller that names a model (Jev never grades its own labels; no model fills the holdout).
 */
import { readFileSync } from "node:fs";
import { CUISINES, type CuisineKey } from "@/lib/foods/universe/vocabulary";
import { parseCsv } from "@/scripts/priors/csv";
import type { HoldoutPair } from "@/scripts/pairing/pairs";

export const HOLDOUT_CSV = "docs/pairing/holdout-pairs.csv";
export const HOLDOUT_HEADER = ["pair_id", "cuisine", "occasion", "anchor", "side", "label", "labeller", "note"] as const;
/** §5: at least 400 labelled pairs; and, so no cuisine is left thin, at least this many per cuisine. */
export const MIN_LABELLED = 400;
export const MIN_PER_CUISINE = 25;

/** A labeller that is a model, or says it is. Matched as whole words, case-insensitive. */
export const MODEL_LABELLER = /\b(jev|typesafe|system ?one|gpt[- ]?\d*|openai|claude|anthropic|gemini|grok|llama|deepseek|kimi|mistral|model|llm|ai|bot|auto(mated)?|script)\b/i;

const quote = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function holdoutTemplate(pairs: readonly HoldoutPair[]): string {
  const lines = [HOLDOUT_HEADER.join(",")];
  for (const pair of pairs) {
    lines.push([pair.id, pair.cuisine, pair.occasion, pair.anchorName, pair.sideName, "", "", ""].map(quote).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export type HumanLabel = { id: string; cuisine: CuisineKey; label: 0 | 1; labeller: string };
export type HoldoutLoad = { labels: HumanLabel[]; unsure: number; blank: number; issues: string[] };

export function parseHoldout(text: string, candidates: readonly HoldoutPair[]): HoldoutLoad {
  const issues: string[] = [];
  const header = text.split(/\r?\n/, 1)[0]?.split(",").map((cell) => cell.trim()) ?? [];
  if (header.join(",") !== HOLDOUT_HEADER.join(",")) issues.push(`header must be exactly ${HOLDOUT_HEADER.join(",")}`);
  const byId = new Map(candidates.map((pair) => [pair.id, pair]));
  const seen = new Set<string>();
  const labels: HumanLabel[] = [];
  let unsure = 0, blank = 0;
  parseCsv(text).forEach((row, index) => {
    const line = index + 2;
    const pair = byId.get(row.pair_id ?? "");
    if (!pair) { issues.push(`line ${line}: ${row.pair_id} is not a holdout candidate`); return; }
    if (seen.has(pair.id)) { issues.push(`line ${line}: ${pair.id} appears twice`); return; }
    seen.add(pair.id);
    if (row.cuisine !== pair.cuisine || row.anchor !== pair.anchorName || row.side !== pair.sideName || row.occasion !== pair.occasion) {
      issues.push(`line ${line}: ${pair.id} was edited (cuisine, occasion or names differ from the template)`);
      return;
    }
    const label = (row.label ?? "").trim().toLowerCase();
    const labeller = (row.labeller ?? "").trim();
    if (label === "") { blank += 1; return; }
    if (!["yes", "no", "unsure"].includes(label)) { issues.push(`line ${line}: label must be yes, no or unsure`); return; }
    if (!labeller) { issues.push(`line ${line}: a labelled row needs the labeller's initials`); return; }
    if (MODEL_LABELLER.test(labeller)) { issues.push(`line ${line}: labeller "${labeller}" names a model; the holdout is human-labelled only`); return; }
    if (label === "unsure") { unsure += 1; return; }
    labels.push({ id: pair.id, cuisine: pair.cuisine, label: label === "yes" ? 1 : 0, labeller });
  });
  return { labels, unsure, blank, issues };
}

export function loadHoldout(candidates: readonly HoldoutPair[], path = HOLDOUT_CSV): HoldoutLoad {
  return parseHoldout(readFileSync(path, "utf8"), candidates);
}

/** Why the holdout cannot gate yet, or none: too few labels overall or in a cuisine, or any issue. */
export function holdoutShortfall(load: HoldoutLoad): string[] {
  const out = [...load.issues];
  if (load.labels.length < MIN_LABELLED) out.push(`${load.labels.length} yes/no labels; the gate needs at least ${MIN_LABELLED}`);
  for (const cuisine of CUISINES) {
    const own = load.labels.filter((label) => label.cuisine === cuisine).length;
    if (own < MIN_PER_CUISINE) out.push(`${cuisine}: ${own} yes/no labels; at least ${MIN_PER_CUISINE} per cuisine`);
  }
  return out;
}

/** `pnpm exec tsx scripts/pairing/holdout.ts --write-template`: (re)writes the blank template. Refuses to overwrite labels. */
async function main(argv: readonly string[]): Promise<void> {
  if (!argv.includes("--write-template")) throw new Error("usage: holdout.ts --write-template");
  const { existsSync, writeFileSync } = await import("node:fs");
  const { fixedPairs, holdoutCandidates } = await import("@/scripts/pairing/pairs");
  const candidates = holdoutCandidates(fixedPairs());
  if (existsSync(HOLDOUT_CSV) && loadHoldout(candidates).labels.length + loadHoldout(candidates).unsure > 0) {
    throw new Error(`${HOLDOUT_CSV} already holds labels; not overwriting`);
  }
  writeFileSync(HOLDOUT_CSV, holdoutTemplate(candidates));
  console.log(`wrote ${candidates.length} pairs to ${HOLDOUT_CSV}`);
}

if (process.argv[1]?.endsWith("scripts/pairing/holdout.ts")) {
  main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
