/**
 * The architecture §4.1 search score, in TypeScript.
 *
 * `supabase/migrations/20260912090100_catalog_search.sql` carries the same
 * arithmetic and returns its seven feature columns, so `combine(featuresFromRow(hit))`
 * reproduces the SQL `score` on the same inputs. `tests/search/score-parity.test.ts`
 * holds the two together.
 *
 * The numbers are the frozen ones in docs/plans/2026-09-11-phase-1-2/00-contracts.md §2, corrected
 * 2026-09-11 to match architecture §4.1 exactly (Open question 1).
 */

import { normalizeBrand, type PrepState } from "./query";

export type QualityClass = "analytical" | "survey" | "label" | "crowd";

export type Features = {
  lexical: number;
  trigram: number;
  brandMatch: number;
  prepStateMatch: number;
  userPrior: number;
  qualityClass: number;
  eatsStatus: number;
};

export const WEIGHTS: Readonly<Features> = Object.freeze({
  lexical: 0.35,
  trigram: 0.2,
  brandMatch: 0.15,
  prepStateMatch: 0.1,
  userPrior: 0.1,
  qualityClass: 0.05,
  eatsStatus: 0.05,
});

export const ENERGY_MISMATCH_PENALTY = 0.25;

/** 20 logs in 90 days saturates the prior. */
const PRIOR_SATURATION = 21;

/** similarity() at or above this clears the brand fallback match. */
const BRAND_SIMILARITY_THRESHOLD = 0.6;

const QUALITY: Readonly<Record<QualityClass, number>> = Object.freeze({
  analytical: 1,
  survey: 0.75,
  label: 0.5,
  crowd: 0.25,
});

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function combine(f: Features): number {
  const sum =
    WEIGHTS.lexical * f.lexical +
    WEIGHTS.trigram * f.trigram +
    WEIGHTS.brandMatch * f.brandMatch +
    WEIGHTS.prepStateMatch * f.prepStateMatch +
    WEIGHTS.userPrior * f.userPrior +
    WEIGHTS.qualityClass * f.qualityClass +
    WEIGHTS.eatsStatus * f.eatsStatus;
  return clamp01(sum);
}

export function userPriorScore(logs90d: number): number {
  if (!(logs90d > 0)) return 0;
  return Math.min(1, Math.log(1 + logs90d) / Math.log(PRIOR_SATURATION));
}

export function qualityClassScore(cls: QualityClass, flags: string[]): number {
  const base = QUALITY[cls] ?? 0;
  const penalty = flags.includes("energy_mismatch") ? ENERGY_MISMATCH_PENALTY : 0;
  return Math.max(0, base - penalty);
}

export function prepStateMatchScore(q: PrepState | null, row: PrepState | null): number {
  if (q === null || q === "unknown" || row === null || row === "unknown") return 0.5;
  return q === row ? 1 : 0;
}

export function brandMatchScore(q: string | null, row: string | null, sim: number): number {
  if (q === null) return 0;
  if (row !== null && normalizeBrand(q) === normalizeBrand(row)) return 1;
  return sim >= BRAND_SIMILARITY_THRESHOLD ? BRAND_SIMILARITY_THRESHOLD : 0;
}

export function eatsStatusScore(status: "eats" | "avoid" | null): number {
  if (status === "eats") return 1;
  if (status === "avoid") return 0;
  return 0.5;
}

export function featuresFromRow(row: {
  f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
  f_prior: number; f_quality: number; f_eats: number;
}): Features {
  return {
    lexical: row.f_lexical,
    trigram: row.f_trigram,
    brandMatch: row.f_brand,
    prepStateMatch: row.f_prep,
    userPrior: row.f_prior,
    qualityClass: row.f_quality,
    eatsStatus: row.f_eats,
  };
}
