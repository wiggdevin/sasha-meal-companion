/**
 * Builds the typed substitute graph (Phase 18 D8 part 4, W1b) from licence-safe sources only.
 * Offline build only.
 *
 *   tax   taxonomy: 0.5 when both foods sit in the same SR food group, plus 0.5 × the shared leading
 *         digits (up to 4) of their representative FNDDS food codes / 4. A food's representative
 *         code is the FNDDS 2021-2023 survey food made most purely of it (≥ 80 % of its ingredient
 *         grams; highest share, then lowest code). No code, no second half.
 *   nutr  nutrient-profile similarity: the cosine of the foods' standardised log(1 + amount)
 *         profiles over NUTRIENT_IDS (FoodData Central SR Legacy), floored at 0.
 *   ctx   ingredient-list context from the documented FNDDS 2021-2023 recipes (context.ts, W4),
 *         carried on an edge only when above 0.
 *   like, comp   absent in this build (sources.ts WITHHELD), so they add nothing.
 * Each food keeps its MAX_NEIGHBOURS strongest neighbours that share one of its plate parts, with
 * `sub` at least MIN_SUB (ties by key). TERM_SOURCES names the manifest source of every present
 * term; check-artifact.ts holds each to the licence allowlist.
 */
import type { UniverseItem } from "@/lib/foods/universe/derive";
import {
  MAX_NEIGHBOURS, SUBSTITUTE_WEIGHTS, substituteScore, type SubstituteEdge, type SubstituteGraph, type SubstituteTerm,
} from "@/lib/foods/universe/substitutes";
import type { Context } from "@/scripts/priors/context";
import type { Expansion } from "@/scripts/priors/crosswalk";

export const GRAPH_VERSION = "sub-1.1.0";
export const MIN_SUB = 0.2;
export const REPRESENTATIVE_SHARE = 0.8;
export const ABSENT_TERMS: SubstituteTerm[] = ["like", "comp"];
/** The manifest source ids each present term is built from (sources.ts). */
export const TERM_SOURCES: Partial<Record<SubstituteTerm, string[]>> = {
  tax: ["fndds-2021-2023", "fdc-sr-legacy"], nutr: ["fdc-sr-legacy"], ctx: ["fndds-2021-2023"],
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function representativeCodes(codes: readonly string[], expand: (code: string) => Expansion): Map<string, string> {
  const best = new Map<string, { code: string; share: number }>();
  for (const code of [...codes].sort()) {
    for (const [key, share] of expand(code).shares) {
      if (share < REPRESENTATIVE_SHARE) continue;
      const current = best.get(key);
      if (!current || share > current.share + 1e-12) best.set(key, { code, share });
    }
  }
  return new Map([...best].map(([key, value]) => [key, value.code]));
}

function sharedDigits(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  let depth = 0;
  while (depth < 4 && a[depth] === b[depth]) depth += 1;
  return depth;
}

function standardised(items: readonly UniverseItem[], nutrients: ReadonlyMap<string, number[]>): Map<string, number[]> {
  const vectors = items.map((item) => (nutrients.get(String(item.entry.fdcId)) ?? []).map((value) => Math.log1p(Math.max(0, value))));
  const width = Math.max(0, ...vectors.map((vector) => vector.length));
  const means = Array.from({ length: width }, (_, j) => vectors.reduce((sum, v) => sum + (v[j] ?? 0), 0) / vectors.length);
  const sds = means.map((mean, j) => Math.sqrt(vectors.reduce((sum, v) => sum + ((v[j] ?? 0) - mean) ** 2, 0) / vectors.length) || 1);
  return new Map(items.map((item, i) => [item.entry.id,
    vectors[i].length ? means.map((mean, j) => ((vectors[i][j] ?? 0) - mean) / sds[j]) : []]));
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || !b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let j = 0; j < a.length; j += 1) { dot += a[j] * b[j]; na += a[j] ** 2; nb += b[j] ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function buildSubstituteGraph(items: readonly UniverseItem[], nutrients: ReadonlyMap<string, number[]>,
  representative: ReadonlyMap<string, string>, context: Pick<Context, "ctx">): SubstituteGraph {
  const profiles = standardised(items, nutrients);
  const edges: SubstituteEdge[] = [];
  const sorted = [...items].sort((a, b) => a.entry.id.localeCompare(b.entry.id));
  for (const item of sorted) {
    const candidates: SubstituteEdge[] = [];
    for (const other of sorted) {
      if (other === item || !other.parts.some((part) => item.parts.includes(part))) continue;
      const sameGroup = item.row.srCategory && item.row.srCategory === other.row.srCategory ? 0.5 : 0;
      const tax = round3(sameGroup + 0.5 * (sharedDigits(representative.get(item.entry.id), representative.get(other.entry.id)) / 4));
      const nutr = round3(Math.max(0, cosine(profiles.get(item.entry.id)!, profiles.get(other.entry.id)!)));
      const ctx = context.ctx(item.entry.id, other.entry.id);
      const sub = substituteScore({ tax, nutr, ctx });
      if (sub >= MIN_SUB) candidates.push({ from: item.entry.id, to: other.entry.id, sub, tax, nutr, ...(ctx > 0 ? { ctx } : {}) });
    }
    candidates.sort((a, b) => b.sub - a.sub || a.to.localeCompare(b.to));
    edges.push(...candidates.slice(0, MAX_NEIGHBOURS));
  }
  return { type: "substitute", version: GRAPH_VERSION, weights: SUBSTITUTE_WEIGHTS, absent: ABSENT_TERMS, edges };
}
