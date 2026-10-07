/**
 * The recommendation model `pref-2` (Phase 18 D8, slice W7): one taste value `z` per food and
 * meal occasion, and the plate multiplier `T` the ranking applies. Every food carries its reasons.
 *
 *   P_f       the U.S. population prior, already centred and capped within its part
 *             (the universe prior's `priorScores`); 0 when the prior is neutral
 *   D_{f,o} = clip( 1.2·F − 1.6·L + 0.7·log(1+H) + 0.5·log(1+Q) − 0.7·log(1+N_o)
 *                   + 0.2·S^shop + 0.2·S^pantry, −2, 2 )
 *   w(M)    = 2^(−M/12), and 0 at 60 or more episodes (the prior fades as the account's own
 *             choices accumulate)
 *   G_f     = clip( 0.2 · Σ_j K_fj·D_j / Σ_j K_fj, −0.10, 0.10 ) over at most 8 substitute
 *             neighbours; 0 with no neighbour. A neighbour's taste dislike spreads only along a
 *             reviewed sensory edge of at least 0.7; an occasion's "Not this" never spreads.
 *   z_{f,o} = clip( 0.20·w(M)·P + personal + 0.15·C + clip(0.05·R, −0.20, 0.20), −0.8, 0.8 ),
 *             quantized to steps of 0.01
 *   T(plate) = exp( Σ_f (kcal_f / kcal_plate) · z_{f,o} )
 *
 * `personal` is `G_f` when the food has no direct evidence at that occasion. With direct evidence
 * the spread term is 0 (D8: G = 0 with direct feedback) and `personal` is `0.45·D_{f,o}`, except
 * that the neighbours' estimate is RETAINED as a floor in the evidence's own direction: evidence
 * pointing up keeps at least the estimate, evidence pointing down keeps at most it. The retained
 * amount is reported apart (`retained`, reason `like_liked` / `like_disliked`), never as `spread`.
 * D8's two rules cannot both hold for faint first evidence: a first eaten day 179 days old adds
 * about 0.003 to z, so dropping a 0.10 neighbour lift would lower the food, which W7 acceptance 3
 * forbids. The floor is the reconciliation (decision log 2026-10-06, W7; Sol r1).
 *
 * This module ranks only. It imports nothing but lib/meals/occasion.ts (so never lib/policy), takes no rule or allergy input and returns
 * no verdict: Avoid, allergies and diet rules run in policy before any food reaches it (D4), and a
 * taste dislike lowers rank but never excludes (D6). Callers pass signals only for admitted foods
 * (D5: personal evidence counts only while the verdict is `allowed`). Closed food-world accounts
 * pass no taste values and keep `pref-0` (no taste term), byte-identical to Phase 17.
 *
 * All constants are starting values to fit by respondent holdout and account replay (§5).
 *
 * Pure. No I/O.
 */

import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";

/**
 * A food's tier in a cuisine (the universe vocabulary's `TIERS`), restated here so this
 * module's whole import graph stays inside lib/meals/occasion.ts (tests/meals/ranking-boundary.test.ts);
 * tests/meals/preference.test.ts checks the two lists agree.
 */
export type Tier = "core" | "common" | "occasional";

export const PREFERENCE_VERSION = "pref-2";

export const PREFERENCE_WEIGHTS = {
  /** z: the prior's weight before the fade. */
  prior: 0.2,
  /** z: the direct-evidence weight. */
  direct: 0.45,
  /** z: the stated-cuisine weight. */
  cuisine: 0.15,
  /** z: the confirmed soft-rule weight, and its cap. */
  rules: 0.05,
  rulesCap: 0.2,
  /** z is clipped to ±zCap and quantized to `quantum`. */
  zCap: 0.8,
  quantum: 0.01,
  /** P is clipped to ±priorCap (the universe prior's PRIOR_CAP). */
  priorCap: 1.5,
  /** D_{f,o}'s terms and its cap. */
  favored: 1.2,
  dislike: -1.6,
  eaten: 0.7,
  chosen: 0.5,
  notThis: -0.7,
  shop: 0.2,
  pantry: 0.2,
  directCap: 2,
  /** w(M) = 2^(−M/fadeHalf), and 0 from fadeZeroAt episodes. */
  fadeHalf: 12,
  fadeZeroAt: 60,
  /** G_f: the spread weight, its cap, the neighbour limit and the dislike edge threshold. */
  spread: 0.2,
  spreadCap: 0.1,
  maxNeighbours: 8,
  dislikeEdge: 0.7,
  /** C_f: the best stated-cuisine tier. */
  tiers: { core: 1, common: 0.6, occasional: 0.3 } satisfies Record<Tier, number>,
  /** Recipe search, coach and shopping planner: points per unit of (T − 1). */
  recipeTastePoints: 6,
} as const;

const W = PREFERENCE_WEIGHTS;

/** A food's personal evidence (D5, D6, D7), all for admitted foods only. */
export type FoodSignals = {
  /** F: an explicit Favored mark. */
  favored?: boolean;
  /** L: a confirmed taste dislike matches the food (its family or a sensory tag). */
  disliked?: boolean;
  /** H: decayed distinct eaten days in 180 (the W3 taste profile, `tasteProfile`). */
  eaten?: number;
  /** Q: chosen or added events. */
  chosen?: number;
  /** N_o: "Not this" or swap-away events at an occasion where the food was offered. */
  notThis?: Partial<Record<Occasion, number>>;
  /** S^shop, S^pantry: a used shopping line or a confirmed pantry item inside its time box, 0 to 1. */
  shop?: number;
  pantry?: number;
};

/** A substitute-graph neighbour (the universe substitute graph): never a pairing edge. */
export type SubstituteNeighbour = {
  key: string;
  /** K: the substitute score, 0 to 1. */
  k: number;
  /** A reviewed sensory edge: only such an edge, at K ≥ 0.7, carries a taste dislike. */
  sensory?: boolean;
};

export type PreferenceFood = {
  /** The food's name key (lib/meals/parts.ts `foodKey`), as the ranking looks it up. */
  key: string;
  /** P_f; absent under a neutral prior. */
  prior?: number;
  signals?: FoodSignals;
  /** Tiers of the food in the account's stated cuisines; the best one counts. */
  cuisineTiers?: readonly Tier[];
  /** R_f: the confirmed soft-rule score from `rankFoods`, computed by the caller. */
  rules?: number;
  neighbours?: readonly SubstituteNeighbour[];
};

export type PreferenceInput = {
  /** M: the account's weighted independent choice episodes (the W3 taste profile, `tasteProfile`). */
  episodes: number;
  foods: readonly PreferenceFood[];
};

export type PreferenceReasonCode =
  | "favored" | "disliked" | "eaten" | "chosen" | "not_this" | "on_list" | "in_pantry"
  | "like_liked" | "like_disliked" | "cuisine" | "popular" | "less_common" | "soft_rule";

/**
 * Why a food ranks where it does: each code with its signed contribution to `z` (before the clip
 * and the quantum). `not_this` and the spread codes name the occasions they apply to.
 */
export type PreferenceReason = { code: PreferenceReasonCode; contribution: number; occasions?: Occasion[] };

/** The terms of one occasion's `z`, each already weighted. */
export type PreferenceTerms = {
  z: number;
  prior: number;
  /** 0.45·D_{f,o}; 0 when the food has no direct evidence at this occasion. */
  direct: number;
  /** G_f; 0 with direct evidence (D8). */
  spread: number;
  /**
   * The neighbours' estimate retained as a floor beyond `direct` when direct evidence is weaker than
   * it in the same direction (0 otherwise, and always 0 without direct evidence).
   */
  retained: number;
  cuisine: number;
  rules: number;
};

export type FoodPreference = {
  key: string;
  /** z with no occasion's "Not this" (recipe search, which has no occasion). */
  base: PreferenceTerms;
  byOccasion: Record<Occasion, PreferenceTerms>;
  reasons: PreferenceReason[];
};

/**
 * The compact taste values a plate ranking reads: quantized `z` per food name key, `base` plus
 * the occasions that differ from it. A food absent from the map is neutral (z = 0).
 */
export type TasteEntry = { base: number; occasion?: Partial<Record<Occasion, number>> };
export type TasteValues = Readonly<Record<string, TasteEntry>>;

const clip = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
/** A finite, non-negative count or amount; anything else reads as 0. */
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
/** Four decimals for the reported terms: the same number on every runtime. */
const round4 = (value: number) => Math.round(value * 10_000) / 10_000 + 0;

/** Quantize a z value to the snapshot's step (and clip it): the same number on phone and server. */
export function quantizeZ(z: number): number {
  if (!Number.isFinite(z)) return 0;
  const steps = 1 / W.quantum;
  return Math.round(clip(z, -W.zCap, W.zCap) * steps) / steps + 0;
}

/** w(M) = 2^(−M/12), and 0 at 60 or more episodes. A missing or invalid M reads as 0 (a new account). */
export function priorFade(episodes: number): number {
  const m = count(episodes);
  return m >= W.fadeZeroAt ? 0 : 2 ** (-m / W.fadeHalf);
}

/** Whether the food has direct feedback at an occasion (`null`: no occasion, so no "Not this"). */
export function hasDirectEvidence(signals: FoodSignals | undefined, occasion: Occasion | null): boolean {
  if (!signals) return false;
  return signals.favored === true || signals.disliked === true || count(signals.eaten) > 0
    || count(signals.chosen) > 0 || count(signals.shop) > 0 || count(signals.pantry) > 0
    || (occasion !== null && count(signals.notThis?.[occasion]) > 0);
}

type DirectOptions = { occasion: Occasion | null; dislike: boolean };

function directRaw(signals: FoodSignals | undefined, { occasion, dislike }: DirectOptions): number {
  if (!signals) return 0;
  return (signals.favored === true ? W.favored : 0)
    + (dislike && signals.disliked === true ? W.dislike : 0)
    + W.eaten * Math.log1p(count(signals.eaten))
    + W.chosen * Math.log1p(count(signals.chosen))
    + (occasion === null ? 0 : W.notThis * Math.log1p(count(signals.notThis?.[occasion])))
    + W.shop * Math.min(1, count(signals.shop))
    + W.pantry * Math.min(1, count(signals.pantry));
}

/** D_{f,o}, clipped to ±2. `occasion: null` leaves out "Not this". */
export function directEvidence(signals: FoodSignals | undefined, occasion: Occasion | null): number {
  return clip(directRaw(signals, { occasion, dislike: true }), -W.directCap, W.directCap);
}

/** The neighbours that count: valid, not the food itself, at most 8, strongest first. */
function usableNeighbours(key: string, neighbours: readonly SubstituteNeighbour[] | undefined): SubstituteNeighbour[] {
  const seen = new Set<string>();
  return (neighbours ?? [])
    .filter((edge) => typeof edge.key === "string" && edge.key !== key
      && typeof edge.k === "number" && Number.isFinite(edge.k) && edge.k > 0 && edge.k <= 1)
    .sort((a, b) => b.k - a.k || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((edge) => (seen.has(edge.key) ? false : (seen.add(edge.key), true)))
    .slice(0, W.maxNeighbours);
}

/**
 * G_f from the neighbours' occasion-free evidence: no "Not this" ever spreads, and a neighbour's
 * taste dislike only along a reviewed sensory edge of at least 0.7. 0 with no neighbour.
 */
export function spreadEvidence(key: string, neighbours: readonly SubstituteNeighbour[] | undefined,
  signalsOf: (key: string) => FoodSignals | undefined): number {
  const edges = usableNeighbours(key, neighbours);
  const total = edges.reduce((sum, edge) => sum + edge.k, 0);
  if (total <= 0) return 0;
  const weighted = edges.reduce((sum, edge) => sum + edge.k * clip(directRaw(signalsOf(edge.key),
    { occasion: null, dislike: edge.sensory === true && edge.k >= W.dislikeEdge }), -W.directCap, W.directCap), 0);
  return clip(W.spread * weighted / total, -W.spreadCap, W.spreadCap);
}

/**
 * The personal term: the neighbours' estimate `G` with no direct evidence; with it, `0.45·D`, held
 * on the far side of `G` in its own direction so that evidence never moves a food against itself.
 */
export function personalTerm(direct: number, spread: number, hasDirect: boolean): { value: number; retained: number } {
  if (!hasDirect) return { value: spread, retained: 0 };
  const own = W.direct * direct;
  const value = own >= 0 ? Math.max(own, spread) : Math.min(own, spread);
  return { value, retained: value - own };
}

/** C_f: the best stated-cuisine tier (core 1, common 0.6, occasional 0.3, else 0). */
export function cuisineScore(tiers: readonly Tier[] | undefined): number {
  return Math.max(0, ...(tiers ?? []).map((tier) => W.tiers[tier] ?? 0));
}

function termsFor(food: PreferenceFood, occasion: Occasion | null, fade: number, spread: number): PreferenceTerms {
  const prior = W.prior * fade * clip(finite(food.prior), -W.priorCap, W.priorCap);
  const direct = hasDirectEvidence(food.signals, occasion);
  const d = directEvidence(food.signals, occasion);
  const personal = personalTerm(d, spread, direct);
  const cuisine = W.cuisine * cuisineScore(food.cuisineTiers);
  const rules = clip(W.rules * finite(food.rules), -W.rulesCap, W.rulesCap);
  const z = quantizeZ(prior + personal.value + cuisine + rules);
  return { z, prior: round4(prior), direct: round4(direct ? W.direct * d : 0), spread: round4(direct ? 0 : spread),
    retained: round4(personal.retained), cuisine: round4(cuisine), rules: round4(rules) };
}

/**
 * The reasons, each with its effective contribution. The reasons without `occasions` sum to the
 * base (occasion-free) terms: the direct terms scaled by the clip D applied, the spread (or the
 * retained floor), cuisine, prior and soft rule. Each `not_this` reason is its occasion's change in
 * the whole personal term (direct + spread + retained), so base reasons plus that occasion's
 * `not_this` sum to the occasion's terms.
 */
function reasonsFor(food: PreferenceFood, base: PreferenceTerms, byOccasion: Record<Occasion, PreferenceTerms>,
  hasBaseDirect: boolean): PreferenceReason[] {
  const s = food.signals ?? {};
  const personal = (terms: PreferenceTerms) => terms.direct + terms.spread + terms.retained;
  const reasons: PreferenceReason[] = [];
  const add = (code: PreferenceReasonCode, contribution: number, occasions?: Occasion[]) => {
    const value = round4(contribution);
    if (value !== 0) reasons.push({ code, contribution: value, ...(occasions ? { occasions } : {}) });
  };
  const parts: [PreferenceReasonCode, number][] = [
    ["favored", s.favored === true ? W.favored : 0],
    ["disliked", s.disliked === true ? W.dislike : 0],
    ["eaten", W.eaten * Math.log1p(count(s.eaten))],
    ["chosen", W.chosen * Math.log1p(count(s.chosen))],
    ["on_list", W.shop * Math.min(1, count(s.shop))],
    ["in_pantry", W.pantry * Math.min(1, count(s.pantry))],
  ];
  const raw = parts.reduce((sum, [, value]) => sum + value, 0);
  const scale = raw === 0 ? 0 : clip(raw, -W.directCap, W.directCap) / raw;
  for (const [code, value] of parts) add(code, W.direct * value * scale);
  for (const occasion of OCCASIONS) {
    if (count(s.notThis?.[occasion]) <= 0) continue;
    const terms = byOccasion[occasion];
    add("not_this", personal(terms) - personal(base), [occasion]);
  }
  const value = hasBaseDirect ? base.retained : base.spread;
  if (value !== 0) add(value > 0 ? "like_liked" : "like_disliked", value);
  add("cuisine", base.cuisine);
  add(base.prior >= 0 ? "popular" : "less_common", base.prior);
  add("soft_rule", base.rules);
  return reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * `pref-2` for every food: quantized `z` per occasion and without one, the weighted terms, and the
 * reasons. Deterministic: the same input gives the same output on every runtime. A food listed
 * twice keeps its first entry.
 */
export function preferenceScores(input: PreferenceInput): Record<string, FoodPreference> {
  const fade = priorFade(input.episodes);
  const byKey = new Map<string, PreferenceFood>();
  for (const food of input.foods) if (typeof food.key === "string" && !byKey.has(food.key)) byKey.set(food.key, food);
  const signalsOf = (key: string) => byKey.get(key)?.signals;
  const out = new Map<string, FoodPreference>();
  for (const key of [...byKey.keys()].sort()) {
    const food = byKey.get(key) as PreferenceFood;
    const spread = spreadEvidence(key, food.neighbours, signalsOf);
    const base = termsFor(food, null, fade, spread);
    const byOccasion = Object.fromEntries(OCCASIONS.map((occasion) =>
      [occasion, termsFor(food, occasion, fade, spread)])) as Record<Occasion, PreferenceTerms>;
    out.set(key, { key, base, byOccasion,
      reasons: reasonsFor(food, base, byOccasion, hasDirectEvidence(food.signals, null)) });
  }
  // Own entries for every key, "__proto__" included (a plain assignment would set the prototype).
  return Object.fromEntries(out);
}

/** The compact values a ranking carries: zeros left out, occasions only where they differ. */
export function tasteValues(scores: Readonly<Record<string, FoodPreference>>): Record<string, TasteEntry> {
  const out = new Map<string, TasteEntry>();
  for (const key of Object.keys(scores).sort()) {
    const { base, byOccasion } = scores[key];
    const occasion: Partial<Record<Occasion, number>> = {};
    for (const o of OCCASIONS) if (byOccasion[o].z !== base.z) occasion[o] = byOccasion[o].z;
    if (base.z === 0 && !Object.keys(occasion).length) continue;
    out.set(key, Object.keys(occasion).length ? { base: base.z, occasion } : { base: base.z });
  }
  return Object.fromEntries(out);
}

/** A food's z at an occasion (`null`: the occasion-free value); 0 for an unknown food or bad value. */
export function tasteZ(values: TasteValues | undefined, key: string, occasion: Occasion | null): number {
  const entry = values && Object.hasOwn(values, key) ? values[key] : undefined;
  if (!entry) return 0;
  const raw = occasion !== null && entry.occasion && Object.hasOwn(entry.occasion, occasion)
    ? entry.occasion[occasion] : entry.base;
  return typeof raw === "number" && Number.isFinite(raw) ? clip(raw, -W.zCap, W.zCap) : 0;
}

/** Whether a ranking has taste values at all: an empty map is no taste term (pref-0), as absent. */
export function hasTasteValues(values: TasteValues | undefined): values is TasteValues {
  return !!values && Object.keys(values).length > 0;
}

/** One item on a plate or in a recipe: its name key and its share basis (kcal or grams). */
export type TasteItem = { key: string; amount: number };

/**
 * T = exp(Σ share_f · z_{f,o}), the share being each item's part of the plate's total amount
 * (calories for a plate, grams for a recipe). 1 when the total is not positive.
 */
export function tasteMultiplier(items: readonly TasteItem[], values: TasteValues | undefined,
  occasion: Occasion | null): number {
  const raw = items.map((item) => count(item.amount));
  // Shares are scale-free: normalising by the largest amount first keeps the sum finite.
  const largest = Math.max(0, ...raw);
  const amounts = largest > 0 && Number.isFinite(largest) ? raw.map((amount) => amount / largest) : raw;
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (!(total > 0) || !Number.isFinite(total)) return 1;
  return Math.exp(items.reduce((sum, item, i) => sum + (amounts[i] / total) * tasteZ(values, item.key, occasion), 0));
}

/** Recipe search, coach and shopping planner: RECIPE_TASTE_POINTS × (T − 1) over ingredient grams. */
export function recipeTastePoints(ingredients: readonly TasteItem[], values: TasteValues | undefined,
  occasion: Occasion | null = null): number {
  return W.recipeTastePoints * (tasteMultiplier(ingredients, values, occasion) - 1);
}
