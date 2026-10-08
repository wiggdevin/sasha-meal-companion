import { focusOf, mealEvidenceOf, openWorldOf } from "@/lib/foods/rule-marks";
import { livePool, plateChips } from "@/lib/meals/open-world";
import type { MealEvidence } from "@/lib/meals/snapshot";
import { componentFor, type Food } from "@/lib/foods";
import { isUntimed, occasionAt, type Occasion } from "@/lib/meals/occasion";
import { bestPerAnchor, rankPlates } from "@/lib/meals/plate";
import { sumComponents } from "@/lib/plan/slot-override";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import type { FoodPrefRefCache } from "@/lib/foods/prefs-client";
import type { RecipeRow } from "@/lib/recipes-client";
import type { MealReasonChip } from "@/lib/meals/open-world";
import type { FoodComponent, Macros, SlotId } from "@/lib/types";

export type SavedMealRow = { id: string; name: string; items?: Record<string, unknown>[] };
export type SwapAlternative = {
  id: string; name: string; source: "Your foods" | "Your recipe" | "Saved meal";
  components: FoodComponent[]; macros: Macros; proteinKey: string;
  foodIds: string[];
  /**
   * Phase 18 W8: why an open food-world plate is offered ("eaten_often": "You eat this often",
   * "on_list": "On your list"). Absent on saved rows and on every closed account's row.
   */
  reasons?: MealReasonChip[];
};

function withinTarget(kcal: number, target: Macros): boolean {
  return target.kcal > 0 && kcal > 0 && Math.abs(kcal - target.kcal) <= target.kcal * 0.1;
}

function visibleKey(row: SwapAlternative): string {
  return [row.source, row.name.trim().replace(/\s+/g, " ").toLowerCase(),
    ...(["kcal", "protein", "carbs", "fat"] as const)
      .map((key) => Math.round(row.macros[key]))].join("|");
}

function refFoods(foods: Record<string, Food>, refs: FoodPrefRefCache): Map<string, Food> {
  const byRef = new Map<string, Food>();
  for (const food of Object.values(foods)) {
    if (food.status !== "eats") continue;
    const saved = refs[food.id];
    if (saved?.userRefId) byRef.set(saved.userRefId, food);
    if (saved?.catalogRefId) byRef.set(saved.catalogRefId, food);
  }
  return byRef;
}

/** Saved rows are used only when every ingredient resolves to this account's current Eats. */
function savedAlternative(
  id: string, name: string, source: SwapAlternative["source"],
  items: Record<string, unknown>[], servings: number,
  target: Macros, foods: Map<string, Food>,
): SwapAlternative | null {
  if (items.length === 0 || !Number.isFinite(servings) || servings <= 0) return null;
  const resolved = items.map((item) => {
    const ref = typeof item.food_ref_id === "string" ? item.food_ref_id : null;
    const food = ref ? foods.get(ref) : undefined;
    const grams = Number(item.grams) / servings;
    const perUnit = food && accountUnitGrams(food);
    return food && perUnit && Number.isFinite(grams) && grams > 0
      ? { food, grams, perUnit } : null;
  });
  if (resolved.some((item) => item === null)) return null;
  const ingredients = resolved.filter((item): item is NonNullable<typeof item> => item !== null);
  const raw = ingredients.map(({ food, grams, perUnit }) => componentFor(food, grams / perUnit));
  const rawKcal = sumComponents(raw).kcal;
  if (rawKcal <= 0) return null;
  const ratio = target.kcal / rawKcal;
  if (ratio < 0.4 || ratio > 2.5) return null;
  const components = ingredients.map(({ food, grams, perUnit }) =>
    componentFor(food, Math.round(grams * ratio / perUnit * 100) / 100));
  const macros = sumComponents(components);
  if (!withinTarget(macros.kcal, target)) return null;
  return { id, name, source, components, macros,
    foodIds: ingredients.map(({ food }) => food.id),
    proteinKey: ingredients.find(({ food }) => food.role === "protein")?.food.id ?? id };
}

/** Generated rows ranked when no date is given (the sheet's rotation is then fixed). */
const UNDATED = "2026-01-01";
/** Coherent plates read per sheet, before the distinct-protein pass picks eight. */
const PLATE_ROWS = 40;

/**
 * Saved rows first where they fit, then this account's own coherent plates for the slot's
 * occasion (lib/meals, Phase 17 O1): the best plate per protein, then the next-best plates. The
 * slot's `clock` ("07:30") sets the occasion; without one the plate follows its anchor.
 *
 * Phase 18 W8: when `eligible` is an open food-world account's set, the plates come from its
 * admitted pool (Favored and universe foods, lib/meals/open-world.ts) with its taste values and
 * the open search (fit first, the kosher plate rule, the anchor bound). Each such row's `foodIds`
 * are pool ids the same set vouches for (`eligible.has`), and it carries its reason chips.
 */
export function swapAlternatives(input: {
  slot: SlotId; target: Macros; foods: Record<string, Food>; refs?: FoodPrefRefCache;
  recipes?: RecipeRow[]; savedMeals?: SavedMealRow[]; currentMealId?: string;
  clock?: string | null; occasion?: Occasion; date?: string;
  /** The account's snapshot evidence (Phase 17 O2). Absent: read from `eligible`, else curated. */
  evidence?: MealEvidence | null;
  /** The verified eligible set the foods were filtered by; its `meals` evidence is used. */
  eligible?: ReadonlySet<string>;
}): SwapAlternative[] {
  const { slot, target, foods } = input;
  const evidence = input.evidence !== undefined ? input.evidence : mealEvidenceOf(input.eligible);
  const refs = refFoods(foods, input.refs ?? {});
  const saved = [
    ...(input.recipes ?? []).map((row) => savedAlternative(`recipe:${row.id}`, row.name,
      "Your recipe", row.items, Number(row.servings), target, refs)),
    ...(input.savedMeals ?? []).map((row) => savedAlternative(`saved:${row.id}`, row.name,
      "Saved meal", row.items ?? [], 1, target, refs)),
  ].filter((row): row is SwapAlternative => row !== null);
  const occasion = input.occasion ?? occasionAt(input.clock, { slot });
  const open = openWorldOf(input.eligible);
  // `null`: a snapshot was required and none usable is held, so no new plate is offered (D2).
  // W11 (D7): an active shopping focus ranks the rows by (fits, coverage, score) on a dated sheet.
  const focus = input.date ? focusOf(input.eligible, input.date) : undefined;
  const { plates } = target.kcal > 0 && evidence !== null ? rankPlates({ date: input.date ?? UNDATED, slot, occasion,
    untimed: !input.occasion && isUntimed(occasion, input.clock), target, foods: open ? livePool(open, foods) : foods,
    ...(evidence ? { evidence } : {}), ...(open ? { taste: open.taste, open: open.ranking } : {}),
    ...(focus ? { focus } : {}) }) : { plates: [] };
  const firsts = bestPerAnchor(plates);
  const ordered = [...firsts, ...plates.filter((plate) => !firsts.includes(plate))].slice(0, PLATE_ROWS);
  // One row per dish: the same plate with and without its cooking fat is one choice.
  const dishes = new Set<string>();
  const composed: SwapAlternative[] = ordered.filter((plate) => withinTarget(plate.macros.kcal, target))
    .filter((plate) => !dishes.has(plate.name) && !!dishes.add(plate.name))
    .map((plate): SwapAlternative => {
      const reasons = open ? plateChips(plate, open.chips) : [];
      return { id: `plate:${plate.key}`, name: plate.name, source: "Your foods",
        components: plate.components, macros: plate.macros,
        proteinKey: plate.anchor?.id ?? `plate:${plate.key}`,
        foodIds: plate.rows.map((row) => row.food.id), ...(reasons.length ? { reasons } : {}) };
    });
  const candidates = [...saved, ...composed].filter((row) => row.id !== input.currentMealId);
  const result: SwapAlternative[] = [];
  const ids = new Set<string>();
  const proteins = new Set<string>();
  const visible = new Set<string>();
  for (const row of candidates) {
    const key = visibleKey(row);
    if (ids.has(row.id) || proteins.has(row.proteinKey) || visible.has(key)) continue;
    result.push(row); ids.add(row.id); proteins.add(row.proteinKey); visible.add(key);
    if (result.length >= 8) return result;
  }
  for (const row of candidates) {
    const key = visibleKey(row);
    if (ids.has(row.id) || visible.has(key)) continue;
    result.push(row); ids.add(row.id); visible.add(key);
    if (result.length >= 8) break;
  }
  return result;
}
