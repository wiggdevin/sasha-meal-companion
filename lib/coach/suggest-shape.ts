/**
 * Plan-sheet chip shaping for the admitted-pool suggestion build (lib/coach/suggest-pool.ts):
 * the on-hand pool, the light target, and the per-chip filter and order over `rankPlates`'
 * plates. Kept outside lib/meals so the plate engine itself is unchanged; every helper here only
 * narrows or reorders foods and plates that admission already allowed, and never sets a number a
 * rule reads.
 *
 * Pure. No I/O.
 */
import type { SuggestInput } from "@/lib/coach/executors";
import type { Food } from "@/lib/foods";
import type { Occasion } from "@/lib/meals/occasion";
import { foodKey } from "@/lib/meals/parts";
import type { Plate } from "@/lib/meals/plate";
import { tasteZ, type TasteValues } from "@/lib/meals/preference";
import type { MealEvidence } from "@/lib/meals/snapshot";
import { proteinFit } from "@/lib/meals/size";
import { plateMinutes } from "@/lib/plan/prep-minutes";
import {
  ON_HAND_COPY, ON_HAND_EMPTY_MESSAGE, ON_HAND_NO_FIT_MESSAGE, ON_HAND_SOURCES,
  type OnHandSource,
} from "@/lib/plan/chips";
import type { Macros } from "@/lib/types";

/** One food the account has on hand, by name, and where that came from. */
export type OnHandEntry = { name: string; source: Exclude<OnHandSource, "favored"> };

/** Shaped build: the plates to offer, and the line and offer the sheet shows with them. */
export type ShapedPlates = {
  plates: Plate[];
  notice?: string;
  offer?: "add_items";
  /** Per plate key: where its foods came from ("From your pantry photo"). */
  sources?: ReadonlyMap<string, string>;
  /** Per plate key: derived prep minutes, when `maxMinutes` asked for them. */
  minutes?: ReadonlyMap<string, number>;
};

/** A share of 0.5-1; anything else means "no scaling". */
export function lightTarget(target: Macros, scale: number | undefined): Macros {
  if (scale === undefined || !Number.isFinite(scale) || scale < 0.5 || scale >= 1) return target;
  // Protein never shrinks (AGENTS.md: a calorie change never moves the protein portion). The
  // calories keep at least the protein's own energy, so a light plate can still carry it.
  const kcal = Math.max(Math.round(target.kcal * scale), Math.round(target.protein * 4 * 1.1));
  return { kcal, protein: target.protein, carbs: Math.round(target.carbs * scale),
    fat: Math.round(target.fat * scale) };
}

const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ")
  .split(/\s+/).filter(Boolean).map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));

/** Every word of the on-hand name appears in the food's name ("chicken" → "Chicken breast"). */
export function onHandMatches(food: Pick<Food, "name">, name: string): boolean {
  const want = words(name);
  if (want.length === 0) return false;
  const have = new Set(words(food.name));
  return want.every((word) => have.has(word));
}

/** A Favored (account) food, not an admitted universe item. */
export const isFavored = (food: Pick<Food, "id">) => !food.id.startsWith("universe:");

/** The best on-hand source per pool food id, in ON_HAND_SOURCES order. */
export function onHandSources(foods: readonly Food[], entries: readonly OnHandEntry[]): Map<string, OnHandSource> {
  const out = new Map<string, OnHandSource>();
  const rank = (source: OnHandSource) => ON_HAND_SOURCES.indexOf(source);
  for (const food of foods) {
    for (const entry of entries) {
      if (!onHandMatches(food, entry.name)) continue;
      const current = out.get(food.id);
      if (current === undefined || rank(entry.source) < rank(current)) out.set(food.id, entry.source);
    }
  }
  return out;
}

/** A plate's one source line: the best source any of its foods has, else Favorites. */
export function plateSource(plate: Plate, sources: ReadonlyMap<string, OnHandSource>): string {
  const ranked = plate.rows.map((row) => sources.get(row.food.id))
    .filter((source): source is OnHandSource => source !== undefined)
    .sort((a, b) => ON_HAND_SOURCES.indexOf(a) - ON_HAND_SOURCES.indexOf(b));
  return ON_HAND_COPY[ranked[0] ?? "favored"];
}

/**
 * "Use what I have" in tiers, every tier inside the admitted pool:
 *  1. only foods on hand;
 *  2. Favored foods too, but each plate holds at least one food on hand;
 *  3. Favored foods alone, with a line saying nothing on hand fits.
 * With nothing known on hand, tier 3 with the add-items offer; with on-hand names none of which is
 * an admitted food (an Avoid-listed pantry item, say), tier 3 at once. `rank` builds plates for a pool.
 */
export function onHandPlates(foods: readonly Food[], entries: readonly OnHandEntry[],
  rank: (pool: readonly Food[]) => Plate[]): ShapedPlates {
  const sources = onHandSources(foods, entries);
  const favored = foods.filter(isFavored);
  const labelled = (plates: Plate[], notice?: string, offer?: "add_items"): ShapedPlates => ({
    plates, sources: new Map(plates.map((plate) => [plate.key, plateSource(plate, sources)])),
    ...(notice ? { notice } : {}), ...(offer ? { offer } : {}),
  });
  if (entries.length === 0) return labelled(rank(favored), ON_HAND_EMPTY_MESSAGE, "add_items");
  // Known on hand, but none of it is an admitted food: Favorites, and the line that says why.
  if (sources.size === 0) return labelled(rank(favored), ON_HAND_NO_FIT_MESSAGE);
  const onHand = foods.filter((food) => sources.has(food.id));
  const strict = rank(onHand);
  if (strict.length) return labelled(strict);
  const mixed = rank([...new Map([...favored, ...onHand].map((food) => [food.id, food])).values()])
    .filter((plate) => plate.rows.some((row) => sources.has(row.food.id)));
  if (mixed.length) return labelled(mixed);
  return labelled(rank(favored), ON_HAND_NO_FIT_MESSAGE);
}

/** How well the account already knows a plate, 0 (never logged or eaten) to 1 (a daily usual). */
export function familiarity(plate: Plate, occasion: Occasion, evidence: MealEvidence | undefined,
  taste: TasteValues | undefined): number {
  let most = 0;
  for (const row of plate.rows) {
    const key = foodKey(row.food);
    const history = evidence?.history[key]?.[occasion];
    // A qualifying history score is 0.75-1 (lib/meals/history.ts): 0.5-1 here.
    if (typeof history === "number") most = Math.max(most, 0.5 + 2 * (history - 0.75));
    if (tasteZ(taste, key, occasion) > 0) most = Math.max(most, 0.5);
  }
  return Math.min(1, Math.max(0, most));
}

/** The plate filters a chip applies BEFORE the best-per-anchor cut, so an anchor's other plates
 *  can stand in for one the filter removes. */
export type PlateFilter = {
  /** Every plate's key → its derived minutes, when `maxMinutes` asked for them. */
  minutes?: Map<string, number>;
  /** Anchors of plates said no to: their other plates rank behind every fresh anchor. */
  excludedAnchors: Set<string>;
  /** `maxMinutes` removed every plate. */
  noneQuick: boolean;
};

/**
 * `excludeIds` out, then `maxMinutes`, then (`proteinFirst`) plates that meet the slot's protein
 * when any does. Runs over ALL ranked plates, before `bestPerAnchor`: filtering after the cut
 * dropped an anchor whose best plate was excluded or slow even when its next plate qualified.
 */
export function filterPlates(plates: readonly Plate[], input: SuggestInput, target: Macros,
  filter: PlateFilter): Plate[] {
  const excluded = new Set(input.excludeIds ?? []);
  for (const plate of plates) {
    if (excluded.has(plate.key) && plate.anchorKey !== null) filter.excludedAnchors.add(plate.anchorKey);
  }
  let kept = plates.filter((plate) => !excluded.has(plate.key));
  if (input.maxMinutes !== undefined) {
    const minutes = (filter.minutes ??= new Map());
    for (const plate of kept) {
      if (!minutes.has(plate.key)) minutes.set(plate.key, plateMinutes(plate.rows.map((row) => row.food)));
    }
    const limit = input.maxMinutes;
    kept = kept.filter((plate) => (minutes.get(plate.key) as number) <= limit);
    if (!kept.length) filter.noneQuick = true;
  }
  if (input.proteinFirst) {
    const meets = kept.filter((plate) => proteinFit(plate.macros, target) >= 0.97);
    if (meets.length) kept = meets;
  }
  return kept;
}

/** The chip's own order, as a multiplier on each (already per-anchor) plate's card fit. */
export function weighPlates(plates: readonly Plate[], input: SuggestInput, filter: PlateFilter,
  context: { occasion: Occasion; evidence?: MealEvidence; taste?: TasteValues }):
  { plate: Plate; weight: number }[] {
  return plates.map((plate) => {
    let weight = filter.excludedAnchors.has(plate.anchorKey ?? "") ? 0.8 : 1;
    if (input.proteinFirst && plate.macros.kcal > 0) {
      // Protein's share of the plate's energy: 0.15 → ×0.9, 0.45 → ×1.2.
      const share = (plate.macros.protein * 4) / plate.macros.kcal;
      weight *= 0.75 + Math.min(0.45, Math.max(0, share));
    }
    if (input.novelty) weight *= 1 - 0.5 * familiarity(plate, context.occasion, context.evidence, context.taste);
    return { plate, weight };
  });
}

/** A card can be placed only when every item carries a real `food_refs.id` (a uuid). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const placeableRef = (id: string | null | undefined): boolean => typeof id === "string" && UUID.test(id);

/** True when the input carries any chip shaping (the plain build is then byte-identical). */
export function isShaped(input: SuggestInput): boolean {
  return Boolean(input.plateTitles || input.proteinFirst || input.onHandOnly || input.novelty
    || input.maxMinutes !== undefined || input.sizeScale !== undefined || input.excludeIds?.length
    || input.date);
}
