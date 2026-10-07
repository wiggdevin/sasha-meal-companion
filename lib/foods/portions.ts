/**
 * The one place that turns a food's raw serving data into the UI's portion contract — search,
 * detail, the client mirror (lib/catalog-client.ts) and the offline bundled list (lib/food-db.ts)
 * all call this, so they cannot disagree about rounding, default selection or the 100 g tail.
 */

export type Portion = { id: string | null; label: string; grams: number; kcal: number | null };

/** A real (database- or bundle-backed) portion, before it is turned into the wire `Portion` shape. */
export type RealPortionInput = { id: string | null; label: string; grams: number; isDefault: boolean };

/** round(grams × kcalPer100g / 100); `null` whenever `kcalPer100g` is `null`. */
export function kcalForPortion(grams: number, kcalPer100g: number | null): number | null {
  return kcalPer100g === null ? null : Math.round((grams * kcalPer100g) / 100);
}

/**
 * `real` is every genuine portion the food carries, already ordered the way the caller wants them
 * shown (search/detail: by `seq`; the offline list: its own household-portion ranking).
 *
 * Returns the real portions in that same order, followed by ALWAYS one synthetic 100 g tail
 * (`id: null`) — even when `real` is empty, so a food with no household portions still has one
 * row to step from.
 *
 * `defaultPortion` is the real portion marked `isDefault`, else the first real one, else `null`
 * when the food has no real portions at all. It is never the synthetic tail.
 */
export function buildPortions(
  real: RealPortionInput[], kcalPer100g: number | null,
): { portions: Portion[]; defaultPortion: Portion | null } {
  const toPortion = (p: RealPortionInput): Portion =>
    ({ id: p.id, label: p.label, grams: p.grams, kcal: kcalForPortion(p.grams, kcalPer100g) });
  const tail: Portion = { id: null, label: "100 g", grams: 100, kcal: kcalForPortion(100, kcalPer100g) };
  const defaultReal = real.find((p) => p.isDefault) ?? real[0] ?? null;
  return {
    portions: [...real.map(toPortion), tail],
    defaultPortion: defaultReal ? toPortion(defaultReal) : null,
  };
}
