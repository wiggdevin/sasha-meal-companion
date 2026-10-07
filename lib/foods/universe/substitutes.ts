/**
 * The typed substitute graph (Phase 18 D8 part 4, D10, slice W1b): which universe foods "taste
 * like" which, so a preference can spread to a food with no direct evidence (W7). Not personal and
 * not NHANES-derived: it comes from FNDDS and FoodData Central only, so the NCHS gate does not
 * apply to it.
 *
 *   sub(f, g) = 0.40·tax + 0.25·nutr + 0.15·ctx + 0.15·like + 0.05·comp
 *
 * A term with no licence-safe source is absent and adds nothing; the other weights are not
 * renormalised, so a pair with thin evidence stays weak. Each food keeps at most eight neighbours
 * that share one of its plate parts. A pairing edge (W1c) is a different type and never lives here.
 *
 * Pure. No I/O.
 */

export const SUBSTITUTE_WEIGHTS = { tax: 0.4, nutr: 0.25, ctx: 0.15, like: 0.15, comp: 0.05 } as const;
export type SubstituteTerm = keyof typeof SUBSTITUTE_WEIGHTS;
export const SUBSTITUTE_TERMS = Object.keys(SUBSTITUTE_WEIGHTS) as SubstituteTerm[];
export const MAX_NEIGHBOURS = 8;

export type SubstituteEdge = { from: string; to: string; sub: number } & Partial<Record<SubstituteTerm, number>>;

export type SubstituteGraph = {
  type: "substitute";
  version: string;
  weights: typeof SUBSTITUTE_WEIGHTS;
  /** Terms with no source in this build (each adds nothing). */
  absent: SubstituteTerm[];
  edges: SubstituteEdge[];
};

/** `sub` from the terms present, rounded as stored. */
export function substituteScore(terms: Partial<Record<SubstituteTerm, number>>): number {
  const raw = SUBSTITUTE_TERMS.reduce((sum, term) => sum + SUBSTITUTE_WEIGHTS[term] * (terms[term] ?? 0), 0);
  return Math.round(raw * 1000) / 1000;
}

/** A food's neighbours, strongest first. */
export function neighboursOf(graph: SubstituteGraph, key: string): SubstituteEdge[] {
  return graph.edges.filter((edge) => edge.from === key).sort((a, b) => b.sub - a.sub || a.to.localeCompare(b.to));
}
