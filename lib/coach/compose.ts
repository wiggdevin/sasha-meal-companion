/**
 * "Give me a recipe for a chicken wrap that fits my daily macros" — T6 §4.
 *
 * Before this the coach answered a wish with a paragraph and one name string. This builds a real
 * meal instead: every food the wish names is searched, a blocked food is swapped for a
 * constraint-safe alternative from the same search where one exists, the grams are sized to the
 * target, and every item goes through the policy. The result is a CARD, and its three buttons are
 * ordinary actions.
 *
 * Port-driven and otherwise pure: no I/O, no Supabase import.
 */

import type { FoodHit } from "@/lib/coach/executors";
import {
  cappedComplement, coveredMacros, fitNote, fitsTarget, macrosFor, missingMacro, sizeItems,
  type MealMacros,
} from "@/lib/coach/compose-size";
import { checkItem, allergenFacts } from "@/lib/coach/policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { Provenance } from "@/lib/types";
import type { MealType } from "@/lib/coach/meal-type";
import type { Part } from "@/lib/coach/portion-bands";
import { splitWish } from "@/lib/coach/wish-negation";
import { isFoodKey } from "@/lib/meals/food-key";
import type { Food } from "@/lib/foods";
import { parseOccasionPhrase } from "@/lib/meals/occasion-phrase";
import type { OpenWorldInputs } from "@/lib/meals/open-world";
import type { FocusRanking } from "@/lib/meals/plate";
export type ComposedItem = {
  name: string; foodRefId: string; catalogFoodRevisionId: number | null;
  grams: number;
  kcalPer100g: number | null; proteinPer100g: number | null;
  carbsPer100g: number | null; fatPer100g: number | null;
  macros: { kcal: number; protein: number; carbs: number; fat: number };
  verdict: "allowed" | "blocked" | "unverified";
  /** Set when this food replaced one the wish named that their constraints block. */
  insteadOf?: string;
  /**
   * Set when the composer ADDED this food — it is not in their wish. "Fits my macros" is a promise
   * the named foods sometimes cannot keep on their own: a chicken wrap carries no fat (ruling
   * 2026-09-18). At most one per meal, always from their Eats list.
   */
  addedFor?: "fat" | "carbs";
  /** The template role a suggestion card gave this food (lib/coach/compose-template.ts). */
  part?: Part;
  /**
   * The food's wire key (`food:<uuid>` or `catalog:<id>`, lib/meals/food-key.ts), copied from its
   * search hit when the hit knew it. The UI reads it to name the food in a Phase 18 W6 signal event
   * (lib/foods/signals.ts); nothing on the server reads it.
   */
  foodKey?: string;
};

/** The hit's food key as a composed-item field, or nothing when it has none or a malformed one. */
export function itemFoodKey(hit: Pick<FoodHit, "foodKey">): { foodKey?: string } {
  return isFoodKey(hit.foodKey) ? { foodKey: hit.foodKey } : {};
}

export type ComposedMeal = {
  wish: string;
  slot: string | null;
  items: ComposedItem[];
  totals: MealMacros;
  target: MealMacros;
  flagged: string[];
  /** Every macro within 10 % of the per-meal target, protein first — the bar §4 sets. */
  fitsTarget: boolean;
  /**
   * The one line the card shows when `fitsTarget` is false. A meal that misses the slot used to
   * render exactly like one that hits it, so a wrap 22 g over on protein looked like an answer
   * (measured 2026-09-18). Null when the meal fits.
   */
  fitNote?: string | null;
  /**
   * Set when a DIRECT wish (not a suggestion filler) named foods that cannot share one coherent
   * plate (Phase 18 W9, D12 — the O4 ruling, 2026-10-05). Every named food is still kept in
   * `items`, each with its own policy verdict and foodKey, but `grams`/`macros` carry no claim
   * (0, not a sized guess): `fitsTarget` is false, `fitNote` is null, and nothing is added. The
   * card shows the reason instead of a fit line.
   */
  incomplete?: { reason: string };
  /** Why this option ranked where it did when it came from `suggest_options`. */
  rankNote?: string | null;
  /** Said by the reply when fewer suggestions fit than the user requested. */
  shortfallNote?: string | null;
  /** The distinct Eats-list protein used to build a suggestion candidate. */
  anchorProtein?: string;
  /** True only when every item on a suggestion card resolves to a name on the Eats list. */
  allItemsOnEats?: boolean;
  /**
   * The meal slots still pending today, in order. "Put it in <slot>" is offered even when the
   * wish named no slot; without this the card's middle button simply vanished (Grok pass 1,
   * HIGH 4).
   */
  pendingSlots?: { slot: string; label: string }[];
  /** Plain-language omissions returned to the model with an explicit recipe composition. */
  refusals?: string[];
  /** The meal a suggestion card was built for, read off the slot clock (lib/coach/meal-type.ts). */
  mealType?: MealType;
  /** That clock, "07:30", when known. */
  mealClock?: string | null;
  /** 0–1: how usual the anchor and its sides are together (lib/coach/meal-pairings.ts). */
  pairing?: number;
  /**
   * How a suggestion card was ordered: Jev-ranked, or the deterministic fit order
   * (lib/coach/suggest.ts). Absent on a compose_meal card, which inherits its message's.
   */
  provenance?: Provenance;
};

export type ComposePorts = {
  searchFoods: (
    userId: string, query: string, limit: number, signal?: AbortSignal,
  ) => Promise<FoodHit[]>;
  /**
   * The names on their Eats list. A wish is built from THEIR foods first and only reaches the wider
   * catalog for a term their list has nothing for — without this, "chicken wrap" came back as
   * "Fat, chicken" and "Sandwich wrap, NFS", both real USDA rows and neither one theirs
   * (measured 2026-09-18).
   */
  eatsNames?: (userId: string) => Promise<string[]>;
  /**
   * The account's current admitted plate-search pool (Phase 18 W9, D12): every Favored/admitted
   * food `rankPinnedPlates` may use to fill a part a direct wish didn't name itself. A closed
   * account's caller returns its Eats only; an open account's caller runs a FRESH admission read
   * (D11) and passes the SAME pool through `openWorld` below instead of building this twice.
   * Absent: a direct wish still searches the plate engine with an empty pool (only a wish naming
   * every required part is then coherent). A caller with no direct wish can leave this out.
   */
  pool?: (userId: string) => Promise<Readonly<Record<string, Food>>>;
  /**
   * The SAME fresh admission read `pool` used, with an open account's taste, meal-level plate
   * rule and search bound (W8's `openWorldInputs`) — absent or null: `pool` alone. A caller that
   * has both builds them from one `openWorldInputs(...)` result.
   */
  openWorld?: (userId: string) => Promise<OpenWorldInputs | null>;
  /**
   * `pool`'s account-food ids mapped to the `food_refs.id` a logged, slotted or saved item
   * needs (`GroundedActionItem.foodRefId`) — a bare `Food.id` is the wrong table's key. Absent:
   * falls back to `Food.id` (wrong for an account row; a universe row has no ref at all, a
   * known gap while open-world ships dark).
   */
  poolRefs?: (userId: string) => Promise<Readonly<Record<string, string>>>;
  /**
   * Phase 18 W11 (D7): the account's active shopping focus for `date` (the turn's day when
   * omitted) — `rankPlates`/`rankPinnedPlates` then rank by (fits, coverage, score). Absent, or
   * resolving to undefined (focus off, no Shopping access, a failed read): unchanged ranking.
   */
  focus?: (userId: string, date?: string) => Promise<FocusRanking | undefined>;
};

// Moved to compose-size.ts (target math belongs beside macrosFor/roleOf); re-exported so every
// existing `@/lib/coach/compose` import keeps working unchanged.
export { clampMealTarget, NOTHING_LEFT, snackTarget } from "@/lib/coach/compose-size";

/**
 * Words that are not foods. A wish is a short phrase, so a small stop list beats a parser: what
 * is left is searched, and a term the catalog does not know simply contributes nothing.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "with", "for", "of", "some", "my", "me", "give", "make", "build",
  "please", "that", "fits", "fit", "daily", "macros", "macro", "target", "targets", "recipe",
  "meal", "lunch", "dinner", "breakfast", "snack", "something", "want", "would", "like", "to",
  "in", "on", "it", "is", "can", "you", "i", "have", "has", "plus", "or", "into", "up",
  // How the meal should be, not what is in it: "High protein" searched "high" and "protein" as foods.
  "high", "low", "protein", "carb", "carbs", "fat", "fats", "healthy", "quick", "easy", "light",
  "filling", "big", "small", "kcal", "calories", "calorie", "idea", "ideas", "option",
  "options", "today", "tonight", "now", "morning", "evening", "afternoon", "night",
]);

export const MAX_TERMS = 4;

/** A pouch is never composed: the apple filler in fruit pouches is a confirmed trigger. */
export const POUCH = /\bpouch(es)?\b/i;

/**
 * Words that mean the same food on their list as in a wish. "wrap" is the word the user uses out loud and
 * "Tortilla, corn" is what the catalogue calls the thing in their cupboard, so without this their own
 * tortilla never bound to their own wish and the composer reached the catalogue for a
 * "Sandwich wrap, NFS" instead (Grok pass 1, MEDIUM 10).
 */
const EATS_ALIASES: Record<string, string[]> = {
  wrap: ["tortilla", "wrap", "flatbread"],
  tortilla: ["tortilla", "wrap"],
  jerky: ["jerky"],
  yogurt: ["yogurt", "yoghurt"],
  oil: ["oil"],
  rice: ["rice"],
};

/**
 * Their own name for the term, when their Eats list has one. The LONGEST match wins: their list holds
 * both "Rice, white, cooked" and, one day, "Rice"; the longer name is the specific row the user
 * actually marked, and the shorter one is the accident of a substring.
 */
export function eatsMatch(term: string, eats: string[]): string | null {
  const needles = EATS_ALIASES[term.toLowerCase()] ?? [term.toLowerCase()];
  const hits = eats.filter((name) => {
    const lower = name.toLowerCase();
    return needles.some((needle) => lower.includes(needle));
  });
  if (hits.length === 0) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

/** The foods a wish asks for. A refused food ("no banana", "without chicken") is not one of them. */
export function wishTerms(wish: string): string[] {
  const words = splitWish(wish).positive.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, MAX_TERMS);
}

export function sum(items: ComposedItem[]): MealMacros {
  return items.reduce((total, item) => ({
    kcal: total.kcal + item.macros.kcal,
    protein: Math.round((total.protein + item.macros.protein) * 10) / 10,
    carbs: Math.round((total.carbs + item.macros.carbs) * 10) / 10,
    fat: Math.round((total.fat + item.macros.fat) * 10) / 10,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

const sameName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase().replace(/\s+/g, " ") === b.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/**
 * Whether a search hit IS the account's own Eats row for the name searched: marked Eats, and the
 * same name. Not merely "not on Avoid": a catalog twin with no mark and no allergen tags clears
 * `checkItem` while the food the person actually keeps is a different row.
 */
export function isEatsRow(hit: FoodHit, name: string): boolean {
  return hit.prefStatus === "eats" && sameName(hit.name, name);
}

export { COMPLEMENT_TRIES, complementOrder, fillsRole, pickComplement } from "@/lib/coach/compose-complement";
import { pickComplement } from "@/lib/coach/compose-complement";
import { composeDirectPlate } from "@/lib/coach/compose-pinned";

/**
 * One meal for the wish. Every named food is searched once; the first hit their constraints allow
 * wins, and when every hit for a term is blocked the top one is kept and MARKED (the ruling: it
 * marks, it never refuses).
 *
 * A direct wish (no `anchorProtein`/`exclude` — the user's own typed request) is rebuilt on
 * `rankPinnedPlates`, the pinned, one-slot entry into the SAME plate search the daily layout and
 * swap sheet use (Phase 18 W9, D12): coherence, pairing, sizing and an open account's taste term
 * all apply, and an incoherent named combination comes back `incomplete` rather than a guess. A
 * suggestion filler (`anchorProtein`/`exclude` set, from `lib/coach/suggest.ts`) keeps the pre-W9
 * greedy complement path unchanged — D12: "compose-complement.ts... stay for suggestion callers
 * until W10."
 */
export async function composeMeal(
  userId: string,
  args: { wish: string; slot?: string | null; target: MealMacros;
    anchorProtein?: string; exclude?: string[]; fillTarget?: boolean;
    /** The compose day (W9): which admitted side takes its turn when the pool must fill a part.
     *  Defaults to the server's own today — callers that care about variety pass the turn's own
     *  date (coach-ports.ts does). */
    date?: string;
    /** The slot's own clock ("07:30"), when known: resolves the occasion together with any
     *  phrase in the wish (W9, O4a) when the wish names none. Absent and no phrase: "other". */
    slotClock?: string | null },
  profile: ConstraintProfile,
  ports: ComposePorts,
): Promise<ComposedMeal> {
  const optioned = args.anchorProtein !== undefined || args.exclude !== undefined;
  // Direct `compose_meal` results can be saved as recipes whatever words the wish used, so an
  // Avoid row must stay visible until the server's recipe gate can name its refusal. Suggestion
  // assembly remains separate and excludes Avoid rows before its own candidate-policy pass.
  const isDirectComposition = !optioned;
  // O4a (W9): the occasion phrase leaves the wish before term extraction, so "at a nice relaxed
  // late dinner" never eats into the four-term budget meant for actual food words. A suggestion
  // filler's wish is not the user's own sentence (it is a fixed label like "meal"), so it is
  // never phrase-parsed.
  const occasionPhrase = isDirectComposition ? parseOccasionPhrase(args.wish) : { occasion: null, rest: args.wish };
  const terms = wishTerms(occasionPhrase.rest);
  const eats = (await ports.eatsNames?.(userId)) ?? [];
  const chosen: { hit: FoodHit; insteadOf?: string }[] = [];
  const excluded = new Set((args.exclude ?? []).map((name) => name.toLowerCase()));
  const selected = new Set<string>();
  const verdictOf = (hit: FoodHit) => checkItem({
    foodRefId: hit.foodRefId, name: hit.name, grams: null,
    allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
    onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
  }, profile).verdict;
  /** Avoid stays visible only long enough for the recipe gate to name its refusal. */
  const usable = (hit: FoodHit) =>
    hit.foodRefId !== null && (isDirectComposition || hit.prefStatus !== "avoid") && !POUCH.test(hit.name)
    && (!optioned || !excluded.has(hit.name.toLowerCase()));

  if (args.anchorProtein) {
    const hits = (await ports.searchFoods(userId, args.anchorProtein, 3)).filter(usable);
    const clean = hits.find((hit) => verdictOf(hit) !== "blocked");
    const anchor = clean ?? hits[0];
    if (anchor) {
      chosen.push({ hit: anchor });
      selected.add(anchor.name.toLowerCase());
    }
  }

  for (const term of terms) {
    // Their list first, under their own name for the food; the catalog only for what it lacks.
    const own = eatsMatch(term, eats);
    const fromEats = own === null ? [] : (await ports.searchFoods(userId, own, 3)).filter(usable);
    const searched = fromEats.length > 0
      ? fromEats : (await ports.searchFoods(userId, term, 3)).filter(usable);
    if (searched.length === 0) continue;
    // D12 "resolves to the user's marked row first": a catalog twin of the same name can still
    // outrank the account's own row in `searched`'s order. Move a marked hit to the front.
    const hits = own === null ? searched
      : [...searched].sort((a, b) => Number(isEatsRow(b, own)) - Number(isEatsRow(a, own)));
    const clean = hits.find((hit) => verdictOf(hit) !== "blocked");
    const hit = clean ?? hits[0];
    if (optioned && selected.has(hit.name.toLowerCase())) continue;
    if (clean && clean !== hits[0]) chosen.push({ hit: clean, insteadOf: hits[0].name });
    else chosen.push({ hit });
    if (optioned) selected.add(hit.name.toLowerCase());
  }

  if (isDirectComposition) {
    return composeDirectPlate(userId, args, occasionPhrase, chosen, eats, ports, verdictOf);
  }

  const grams = sizeItems(chosen, args.target);
  const items: ComposedItem[] = chosen.map(({ hit, insteadOf }, index) => {
    const verdict = checkItem({
      foodRefId: hit.foodRefId, name: hit.name, grams: grams[index],
      allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
      onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
    }, profile).verdict;
    return {
      name: hit.name, foodRefId: hit.foodRefId as string,
      catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null,
      grams: grams[index],
      kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
      carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
      macros: macrosFor(hit, grams[index]), verdict,
      ...(insteadOf ? { insteadOf } : {}),
      ...itemFoodKey(hit),
    };
  });

  // A one-off composition may add one missing-macro food. Suggestions may add up to three: a lean
  // protein can need a bounded fat, a second fat after the portion cap, and a carb before it is
  // honestly close enough to the slot calories for the admission gate.
  const complementLimit = args.fillTarget ? 3 : 1;
  for (let added = 0; added < complementLimit; added += 1) {
    const need = items.length > 0 ? missingMacro(sum(items), args.target) : null;
    if (need === null) break;
    const used = new Set([
      ...items.map((item) => item.name.toLowerCase()),
      ...(optioned ? excluded : []),
    ]);
    const covered = coveredMacros(sum(items), args.target);
    const complement = await pickComplement(userId, need, eats, used, covered, profile, ports,
      args.fillTarget === true);
    if (!complement) break;
    const carried = sum(items);
    const gap = need === "fat" ? args.target.fat - carried.fat
      : args.target.carbs - carried.carbs;
    const density = (need === "fat" ? complement.fatPer100g : complement.carbsPer100g) ?? 0;
    const grams = cappedComplement(complement, density <= 0 ? 100 : (gap / density) * 100);
    items.push({
      name: complement.name, foodRefId: complement.foodRefId as string,
      catalogFoodRevisionId: complement.catalogFoodRevisionId ?? null,
      grams,
      kcalPer100g: complement.kcalPer100g, proteinPer100g: complement.proteinPer100g ?? null,
      carbsPer100g: complement.carbsPer100g ?? null, fatPer100g: complement.fatPer100g ?? null,
      macros: macrosFor(complement, grams),
      verdict: checkItem({
        foodRefId: complement.foodRefId, name: complement.name, grams,
        allergenTags: complement.allergenTags ?? null, ...allergenFacts(complement), category: complement.category ?? null,
        onEatsList: complement.prefStatus === "eats",
        onAvoidList: complement.prefStatus === "avoid",
      }, profile).verdict,
      addedFor: need,
      ...itemFoodKey(complement),
    });
  }

  const totals = sum(items);
  const fits = items.length > 0 && fitsTarget(totals, args.target);
  return {
    wish: args.wish, slot: args.slot ?? null, items, totals, target: args.target,
    flagged: items.filter((item) => item.verdict === "blocked").map((item) => item.name),
    fitsTarget: fits,
    // A meal with nothing on it has no miss to report: the card renders nothing at all for it.
    fitNote: fits || items.length === 0 ? null : fitNote(totals, args.target),
    ...(args.anchorProtein ? { anchorProtein: args.anchorProtein } : {}),
  };
}
