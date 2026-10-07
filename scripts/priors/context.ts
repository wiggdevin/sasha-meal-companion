/**
 * The substitute graph's `ctx` term (Phase 18 D8 part 4, slice W4): ingredient-list context from
 * the documented FNDDS 2021-2023 recipes (public domain; FoodData Central CC0 1.0). Two foods are
 * substitutes in context when they go into dishes alongside the same other ingredients (beef and
 * pork both beside tortillas, onion and tomato), whether or not they ever share a dish. Offline
 * build only.
 *
 *   dishes    every FNDDS 2021-2023 food whose recipe, expanded through the W1b crosswalk
 *             (crosswalk.ts `createExpander`), reaches at least two universe foods, each with at
 *             least MIN_SHARE of the dish's grams;
 *   weight    positive pointwise mutual information of a food and a co-ingredient over those
 *             dishes, so an ingredient that goes into everything says little;
 *   ctx(f,g)  the cosine of f's and g's co-ingredient weights, leaving f and g themselves out of
 *             both, rounded to 3 places; 0 when either food is in fewer than MIN_DISHES dishes.
 *
 * Pure apart from the expander it is handed. The Ahn et al. flavour network stays withheld
 * (CC BY-NC-SA 3.0, sources.ts WITHHELD).
 */
import type { Expansion } from "@/scripts/priors/crosswalk";

export const MIN_SHARE = 0.01;
export const MIN_DISHES = 3;

export type Context = { ctx: (a: string, b: string) => number; dishes: number; foods: number };

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function buildContext(codes: readonly string[], expand: (code: string) => Expansion): Context {
  const dishes: string[][] = [];
  for (const code of [...codes].sort()) {
    const keys = [...expand(code).shares].filter(([, share]) => share >= MIN_SHARE).map(([key]) => key).sort();
    if (keys.length >= 2) dishes.push(keys);
  }
  const count = new Map<string, number>();
  const co = new Map<string, Map<string, number>>();
  for (const keys of dishes) {
    for (const key of keys) {
      count.set(key, (count.get(key) ?? 0) + 1);
      const row = co.get(key) ?? new Map<string, number>();
      for (const other of keys) if (other !== key) row.set(other, (row.get(other) ?? 0) + 1);
      co.set(key, row);
    }
  }
  const total = dishes.length;
  const vectors = new Map<string, Map<string, number>>();
  for (const [key, row] of [...co].sort(([a], [b]) => a.localeCompare(b))) {
    if ((count.get(key) ?? 0) < MIN_DISHES) continue;
    const vector = new Map<string, number>();
    for (const [other, both] of [...row].sort(([a], [b]) => a.localeCompare(b))) {
      const pmi = Math.log((both * total) / ((count.get(key) ?? 1) * (count.get(other) ?? 1)));
      if (pmi > 0) vector.set(other, pmi);
    }
    vectors.set(key, vector);
  }
  const ctx = (a: string, b: string): number => {
    const va = vectors.get(a), vb = vectors.get(b);
    if (!va || !vb || a === b) return 0;
    let dot = 0, na = 0, nb = 0;
    for (const [key, value] of va) {
      if (key === a || key === b) continue;
      na += value * value;
      const other = vb.get(key);
      if (other !== undefined) dot += value * other;
    }
    for (const [key, value] of vb) if (key !== a && key !== b) nb += value * value;
    return na && nb ? round3(Math.max(0, dot / Math.sqrt(na * nb))) : 0;
  };
  return { ctx, dishes: total, foods: vectors.size };
}
