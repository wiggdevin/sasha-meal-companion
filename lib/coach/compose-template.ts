/**
 * A suggestion card built as a real meal (2026-10-03, owner report). Before this a card was its
 * anchor plus up to three fillers, each the first Eats food of the right macro in alphabetical
 * order, fat before carbs: "Scallops 387 g · Avocado 93 g · Olive oil 5 g · Banana 77 g" at
 * 7:30 am, with no vegetable and no sense of the time of day.
 *
 * Now the slot's meal type picks a template (breakfast, savoury main, snack), the anchor's family
 * picks its usual sides from the pairing table (lib/coach/meal-pairings.ts), a lunch or dinner
 * gets a vegetable from the Eats list when there is one, and every portion stays inside a
 * plausible serving (lib/coach/portion-bands.ts). A large slot is met with a second side, never
 * with a bigger anchor. Every food is the account's own Eats row for the name searched (marked
 * Eats, same name) and is "allowed" by `checkItem`, not merely "not blocked" (2026-10-03 audit,
 * BLOCKER 1); a card with any food that is not "allowed" is discarded by the caller. A food the
 * person's words refuse ("no banana") never joins the plate.
 *
 * Port-driven and otherwise pure: no I/O, no Supabase import.
 */

import type { FoodHit } from "@/lib/coach/executors";
import {
  eatsMatch, isEatsRow, itemFoodKey, pickComplement, POUCH, sum, wishTerms,
  type ComposedItem, type ComposedMeal, type ComposePorts,
} from "@/lib/coach/compose";
import {
  coveredMacros, FIT_TOLERANCE, fitNote, fitsTarget, macroSources, macrosFor, missingMacro, roleOf,
  type MealMacros,
} from "@/lib/coach/compose-size";
import { sizeWithinBands } from "@/lib/coach/fit-portions";
import {
  anchorSuitability, familyKey, pairingFamily, pairingRank, sidesFor, type Sides,
} from "@/lib/coach/meal-pairings";
import { isUntimed, templateOf, type MealType } from "@/lib/coach/meal-type";
import { portionBand, sidePartOf, type Part, type SidePart } from "@/lib/coach/portion-bands";
import { allergenFacts, checkItem } from "@/lib/coach/policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { refusedBy, splitWish } from "@/lib/coach/wish-negation";

export type TemplateArgs = {
  wish: string;
  slot: string | null;
  target: MealMacros;
  anchorProtein: string;
  mealType: MealType;
  mealClock: string | null;
  /** Which of the usual sides leads, so three cards do not all carry the same banana. */
  rotation: number;
  /** The person's own words, when they typed any. */
  userWish?: string | null;
};

/** Hits read per name: the account's Eats row need not be the search's first result. */
const ROW_SEARCH = 3;
/** Eats names tried per side role before the role is left empty. */
const SIDE_TRIES = 6;
/** The usual sides a card rotates through; anything past these is a less usual pairing. */
const ROTATE_WITHIN = 3;
/** A card's extra sides when the first pass still sits under the slot (a 3-meal day). */
const MAX_EXTRAS = 2;
const MAX_ITEMS = 6;

type Picked = { hit: FoodHit; part: Part; listed: boolean };

const headOf = (name: string) => name.split(",")[0].trim().toLowerCase();

function verdictOf(hit: FoodHit, profile: ConstraintProfile, grams: number | null) {
  return checkItem({
    foodRefId: hit.foodRefId, name: hit.name, grams,
    allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
    onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
  }, profile).verdict;
}

const usable = (hit: FoodHit) =>
  hit.foodRefId !== null && hit.prefStatus !== "avoid" && !POUCH.test(hit.name);

/** Whether a found food really plays the side role its name suggested. */
function playsPart(hit: FoodHit, part: SidePart): boolean {
  const role = roleOf(hit);
  if (part === "fat") return role === "fat";
  if (part === "veg") return role !== "fat" && (hit.kcalPer100g ?? macrosFor(hit, 100).kcal) <= 120;
  return role === "carb";
}

/**
 * The Eats names for one side role, usual pairings first in table order, the leading few rotated
 * by `rotation`, then (where the template allows it) the rest of that role's foods.
 */
export function sidePool(
  eats: readonly string[], part: SidePart, words: readonly string[], rotation: number,
  allowUnlisted: boolean,
): { name: string; listed: boolean }[] {
  const ofPart = eats.filter((name) => sidePartOf(name) === part);
  const listed = ofPart.map((name) => ({ name, rank: pairingRank(name, words) }))
    .filter((row) => row.rank >= 0).sort((a, b) => a.rank - b.rank).map((row) => row.name);
  const k = Math.min(ROTATE_WITHIN, listed.length);
  const lead = k === 0 ? [] : Array.from({ length: k }, (_, i) => listed[(i + rotation) % k]);
  const rest = listed.slice(k);
  const unlisted = allowUnlisted ? ofPart.filter((name) => !listed.includes(name)) : [];
  return [...lead.map((name) => ({ name, listed: true })), ...rest.map((name) => ({ name, listed: true })),
    ...unlisted.map((name) => ({ name, listed: false }))];
}

/** The template's side roles, each with its pairing words and whether off-table foods may fill it. */
function roleWords(sides: Sides, template: "breakfast" | "main" | "snack") {
  return {
    starch: { words: sides.starch, unlisted: template !== "breakfast" },
    fruit: { words: sides.fruit, unlisted: template === "snack" },
    veg: { words: sides.veg, unlisted: template === "main" },
    fat: { words: sides.fat, unlisted: true },
  } as const;
}

/** One meal for a suggestion card, built to the slot's meal type. */
export async function composeTemplateMeal(
  userId: string, args: TemplateArgs, profile: ConstraintProfile, ports: ComposePorts,
): Promise<ComposedMeal> {
  // A food the person's own words refuse ("salmon, no banana") is off this plate's list.
  const refused = splitWish(args.userWish).negated;
  const eats = ((await ports.eatsNames?.(userId)) ?? []).filter((name) => !refusedBy(name, refused));
  /** The account's own allowed Eats row for one of its names, or null. */
  const ownRow = async (name: string): Promise<FoodHit | null> =>
    (await ports.searchFoods(userId, name, ROW_SEARCH)).find((hit) => usable(hit)
      && isEatsRow(hit, name) && verdictOf(hit, profile, null) === "allowed") ?? null;
  const meta = { mealType: args.mealType, mealClock: args.mealClock, anchorProtein: args.anchorProtein };
  const empty: ComposedMeal = { wish: args.wish, slot: args.slot, items: [], totals: sum([]),
    target: args.target, flagged: [], fitsTarget: false, fitNote: null, pairing: 0, ...meta };
  const anchor = refusedBy(args.anchorProtein, refused) ? null : await ownRow(args.anchorProtein);
  if (!anchor) return empty;

  const untimed = isUntimed(args.mealType, args.mealClock);
  const template = templateOf(args.mealType, untimed, pairingFamily(anchor.name)?.usual ?? []);
  const roles = roleWords(sidesFor(anchor.name, template), template);
  const used = new Set([headOf(anchor.name)]);
  const tried = new Set<string>();
  const picked: Picked[] = [{ hit: anchor, part: "anchor", listed: true }];

  /**
   * The first usual side that plays the role. With `gap` (grams of carbs to carry) a side that
   * can carry it inside its plausible band is preferred, so a big plate gets 250 g of rice rather
   * than 50 g of potatoes and a pasta.
   */
  const pick = async (part: SidePart, extra = false, gap?: number): Promise<Picked | null> => {
    const { words, unlisted } = roles[part];
    if (template === "main" && part === "fruit") return null;
    // Fats do not rotate: the usual cooking fat is the usual one on every plate.
    const turn = part === "fat" ? 0 : args.rotation + (extra ? 1 : 0);
    const pool = sidePool(eats, part, words, turn, unlisted)
      .filter((row) => !used.has(headOf(row.name)) && !tried.has(row.name.toLowerCase()));
    let fallback: { hit: FoodHit; row: { name: string; listed: boolean } } | null = null;
    for (const row of pool.slice(0, SIDE_TRIES)) {
      const hit = await ownRow(row.name);
      if (!hit || used.has(headOf(hit.name)) || !playsPart(hit, part)) continue;
      const carries = ((hit.carbsPer100g ?? 0) * portionBand(hit.name, part).max) / 100;
      if (gap !== undefined && carries < gap * 0.9) {
        fallback ??= { hit, row };
        continue;
      }
      fallback = { hit, row };
      break;
    }
    if (!fallback) return null;
    tried.add(fallback.row.name.toLowerCase());
    used.add(headOf(fallback.hit.name));
    used.add(headOf(fallback.row.name));
    return { hit: fallback.hit, part, listed: fallback.row.listed };
  };

  // A side the person named ("salmon with rice") is that side, when it is on their list.
  for (const term of wishTerms(args.userWish ?? "")) {
    const own = eatsMatch(term, eats);
    const part = own === null ? null : sidePartOf(own);
    if (own === null || part === null || picked.some((row) => row.part === part)) continue;
    // A wished side their rules block is left off; the anchor and the rest of the plate stay.
    const hit = await ownRow(own);
    if (!hit || used.has(headOf(hit.name))) continue;
    used.add(headOf(hit.name));
    picked.push({ hit, part, listed: true });
  }

  const has = (part: Part) => picked.some((row) => row.part === part);
  const anchorBand = portionBand(anchor.name, "anchor");
  const anchorDensity = anchor.proteinPer100g ?? 0;
  const anchorSeed = anchorDensity > 0
    ? Math.min(anchorBand.max, Math.max(anchorBand.min, (args.target.protein / anchorDensity) * 100))
    : anchorBand.typical;
  const anchorMacros = macrosFor(anchor, anchorSeed);
  const carbGap = args.target.carbs - anchorMacros.carbs;
  const fatGap = args.target.fat - anchorMacros.fat;
  const needsCarbs = carbGap > Math.max(8, args.target.carbs * 0.1);
  const needsFat = fatGap > Math.max(3, args.target.fat * 0.1);

  const add = async (part: SidePart, extra = false, gap?: number) => {
    if (picked.length >= MAX_ITEMS) return null;
    const row = await pick(part, extra, gap);
    if (row) picked.push(row);
    return row;
  };
  if (template === "main") {
    if (needsCarbs && !has("starch")) await add("starch", false, carbGap);
    if (!has("veg")) await add("veg");
  } else {
    const order: SidePart[] = template === "breakfast" ? ["starch", "fruit"] : ["fruit", "starch"];
    if (needsCarbs && !has("starch") && !has("fruit")) {
      if (!(await add(order[0]))) await add(order[1]);
      // A big breakfast carries both: toast and fruit, oats and berries.
      if (carbGap > 45) await add(has(order[0]) ? order[1] : order[0]);
    }
    if (template === "breakfast" && !has("veg") && args.target.kcal >= 350) await add("veg");
  }
  if (needsFat && !has("fat")) await add("fat");

  /**
   * A second, smaller protein the meal usually carries (Greek yogurt beside eggs at breakfast),
   * for a slot whose protein one plausible anchor cannot reach. Savoury mains never get one:
   * they grow a side instead.
   */
  const addProtein = async (): Promise<boolean> => {
    if (template === "main" || has("protein") || picked.length >= MAX_ITEMS) return false;
    const family = familyKey(anchor.name);
    const names = eats.filter((name) => sidePartOf(name) === null && pairingFamily(name) !== null
      && familyKey(name) !== family && anchorSuitability(name, args.mealType, args.userWish, untimed) === 2
      && !used.has(headOf(name)));
    for (const name of names.slice(0, SIDE_TRIES)) {
      const hit = await ownRow(name);
      if (!hit || used.has(headOf(hit.name)) || !macroSources(hit).has("protein")) continue;
      used.add(headOf(hit.name));
      picked.push({ hit, part: "protein", listed: true });
      return true;
    }
    return false;
  };

  let items = size(picked, args.target);
  for (let extra = 0; extra < MAX_EXTRAS && !fitsTarget(sum(items), args.target); extra += 1) {
    // Inside the bar by a hair is still short when the rest of the plate must shrink around it.
    if (sum(items).protein < args.target.protein * (1 - FIT_TOLERANCE / 2) && await addProtein()) {
      items = size(picked, args.target);
      continue;
    }
    const need = missingMacro(sum(items), args.target);
    if (need === null) break;
    const part: SidePart = need === "fat" ? "fat" : template === "main" ? "starch"
      : has("fruit") ? "starch" : "fruit";
    let row = await add(part, true);
    if (!row && template !== "main" && need === "carbs") row = await add(part === "fruit" ? "starch" : "fruit", true);
    const roleTaken = need === "fat" ? has("fat") : has("starch") || has("fruit");
    if (!row && roleTaken) break;
    if (!row) {
      // No usual side of that role on their list: the old macro complement, still Eats-only.
      const hit = picked.length < MAX_ITEMS ? await pickComplement(userId, need, eats,
        new Set(picked.map((p) => p.hit.name.toLowerCase())), coveredMacros(sum(items), args.target),
        profile, ports, true) : null;
      // Fruit is never the starch of a savoury main, whichever way it was reached.
      if (!hit || used.has(headOf(hit.name))
        || (template === "main" && sidePartOf(hit.name) === "fruit")) break;
      used.add(headOf(hit.name));
      picked.push({ hit, part: need === "fat" ? "fat" : "starch", listed: false });
    }
    items = size(picked, args.target);
  }

  items = size(picked, args.target, true);
  const totals = sum(items);
  const fits = fitsTarget(totals, args.target);
  const sides = picked.slice(1);
  const suit = anchorSuitability(anchor.name, args.mealType, args.userWish, untimed) / 2;
  const vegMissing = template === "main" && !has("veg")
    && eats.some((name) => sidePartOf(name) === "veg");
  // A lunch or dinner that could have had a vegetable and has none scores that slot as a zero.
  const pairing = (suit + sides.reduce((total, row) => total + (row.listed ? 1 : 0.5), 0))
    / (1 + sides.length + (vegMissing ? 1 : 0));
  return {
    wish: args.wish, slot: args.slot, items, totals, target: args.target,
    flagged: items.filter((item) => item.verdict === "blocked").map((item) => item.name),
    fitsTarget: fits, fitNote: fits ? null : fitNote(totals, args.target),
    pairing: Math.round(pairing * 100) / 100, ...meta,
  };

  function size(rows: Picked[], target: MealMacros, final = false): ComposedItem[] {
    const base = rows.map(({ hit, part }) => toItem(hit, part, 0));
    const seeds = seedGrams(rows, target, anchorSeed, template);
    const solved = sizeWithinBands(base, target, seeds, rows.map((row) => row.part === "veg"));
    // Protein is the number that never moves (PRD §7.5): a plate the solver cannot fit keeps the
    // protein-first seed instead of trading protein away for calories.
    const chosen = !final || fitsTarget(sum(solved), target) ? solved : base.map((item, index) => {
      const band = portionBand(item.name, item.part ?? "anchor");
      const grams = Math.min(band.max, Math.max(band.min, Math.round(seeds[index] / band.step) * band.step));
      return { ...item, grams, macros: macrosFor(item, grams) };
    });
    return chosen.map((item, index) => ({
      ...item, verdict: verdictOf(rows[index].hit, profile, item.grams),
    }));
  }
}

/** First guesses for the solver: veg at a usual side, carbs and fat split over their foods. */
function seedGrams(
  rows: Picked[], target: MealMacros, anchorSeed: number, template: "breakfast" | "main" | "snack",
): number[] {
  const count = (parts: Part[]) => Math.max(1, rows.filter((row) => parts.includes(row.part)).length);
  const anchor = macrosFor(rows[0].hit, anchorSeed);
  return rows.map(({ hit, part }) => {
    const band = portionBand(hit.name, part);
    if (part === "anchor") return anchorSeed;
    if (part === "protein") return band.typical;
    // A vegetable side is a set portion, by plate size: 150 g on a big plate, 75 g at breakfast.
    if (part === "veg") {
      if (template !== "main") return band.min;
      return target.kcal >= 600 ? 150 : target.kcal >= 400 ? 120 : 100;
    }
    const isFat = part === "fat";
    const gap = isFat ? target.fat - anchor.fat : target.carbs - anchor.carbs;
    const density = (isFat ? hit.fatPer100g : hit.carbsPer100g) ?? 0;
    if (gap <= 0 || density <= 0) return band.min;
    return ((gap / count(isFat ? ["fat"] : ["starch", "fruit"])) / density) * 100;
  });
}

function toItem(hit: FoodHit, part: Part, grams: number): ComposedItem {
  return {
    name: hit.name, foodRefId: hit.foodRefId as string,
    catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null, grams,
    kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
    carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
    macros: macrosFor(hit, grams), verdict: "allowed", part, ...itemFoodKey(hit),
    ...(part === "fat" ? { addedFor: "fat" as const }
      : part === "starch" || part === "fruit" ? { addedFor: "carbs" as const } : {}),
  };
}
