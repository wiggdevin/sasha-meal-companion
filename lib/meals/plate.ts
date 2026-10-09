/**
 * Ranked, coherent plates for one slot (Phase 17 O1, D4). The one ranking contract the daily
 * layout and the swap sheet share.
 *
 * A candidate is an anchor plus sides by part, following the occasion's template
 * (lib/meals/templates.ts). It is coherent when the template is satisfied, every anchor×side pair
 * scores at least PAIR_FLOOR (lib/meals/affinity.ts) and fruit is not on a main plate. It is
 * sized inside every item's band (lib/meals/size.ts) and scored
 *
 *   score = macro fit × anchor affinity × mean side pairing × date variety
 *
 * with an anchor already used today halved. An open food-world account's taste values (`pref-2`,
 * lib/meals/preference.ts) multiply the score by the plate's taste factor `T`; with none (a closed
 * account, `pref-0`) the score is exactly the Phase 17 one. Variety rotates by date (the old layout's
 * `daysSinceEpoch` rotation), so the same Eats give a different, still coherent, day tomorrow and
 * the same day for the same date everywhere. Nothing here forbids a food: a low affinity ranks it
 * low; only the account's rules (applied before the pool reaches this module) forbid.
 *
 * An open food-world account (Phase 18 W8, D8 part 6, D11) also passes `open`: the anchors searched
 * per occasion are bounded (`OPEN_ANCHOR_LIMIT`, the best half by affinity and taste plus a share
 * that rotates by date), a meal-level rule (`plateOk`, kosher meat with dairy) runs on every
 * assembled plate inside the search, and a plate that meets the slot's fit rule ranks ahead of one
 * that misses it. Without `open` the search is exactly the Phase 17 one.
 *
 * Pure. No I/O.
 */

import type { Food } from "@/lib/foods";
import { daysSinceEpoch } from "@/lib/rotation";
import { macroKcal } from "@/lib/scaling";
import type { FoodComponent, Macros } from "@/lib/types";
import { affinity, PAIR_FLOOR, pairScore, type Scored } from "@/lib/meals/affinity";
import type { Occasion } from "@/lib/meals/occasion";
import type { MealEvidence } from "@/lib/meals/snapshot";
import { hasTasteValues, tasteMultiplier, tasteZ, type TasteValues } from "@/lib/meals/preference";
import { cuisineFactor, type CuisineRanking } from "@/lib/meals/cuisine";
import { byCode, carriesPart, displayName, foodKey, mealFamily, partsOf, unitBand, type Part } from "@/lib/meals/parts";
import { generationPool, poolAnchors } from "@/lib/meals/pool";
import { fitsTarget, macroFit, proteinFit, shapeFit, sizePlate, totalOf, type PlateRow, type SizedRow } from "@/lib/meals/size";
import {
  ANCHORLESS_SNACK, coherentWhole, shortageReason, templateFor, TEMPLATES, unmetRequirements,
  type Template, type TemplateKey,
} from "@/lib/meals/templates";

export type Plate = {
  /** Stable identity: the foods on the plate. */
  key: string;
  anchor: Food | null;
  /** The anchor's food key (null for a fruit-and-fat snack). */
  anchorKey: string | null;
  occasion: Occasion;
  template: TemplateKey;
  rows: SizedRow[];
  components: FoodComponent[];
  macros: Macros;
  name: string;
  score: number;
  fit: number;
  /** Inside 10 % of the calories with 90 % of the protein; otherwise the closest plate in bands. */
  fits: boolean;
  affinity: Scored;
  pairing: number;
  /** The taste factor `T` already in `score` (pref-2); absent when the ranking had no taste values. */
  taste?: number;
  /** D7/W11: the share of this plate's calories from list/pantry foods; absent without `input.focus`. */
  coverage?: number;
};

/**
 * The open food-world search (W8). Absent: the Phase 17 search, unchanged.
 */
export type OpenRanking = {
  /** Anchors searched per occasion (D11 search bound); every admitted food stays in the pool. */
  anchorLimit: number;
  /**
   * A meal-level rule over the assembled plate's foods (lib/policy/plate-rules.ts, D4): false means
   * the plate is never generated. It never loosens a food's own verdict.
   */
  plateOk?: (foods: readonly Food[]) => boolean;
};

/** D11: 24 anchors per occasion plus the side shortlist. */
export const OPEN_ANCHOR_LIMIT = 24;
/**
 * D8 part 6: for an open account a plate that fits the slot ranks ahead of one that misses it. The
 * bonus is larger than any plate's own score (at most e^0.8 ≈ 2.23), so it orders by fit first and
 * by score within each group, in the plate list and in the day's assignment alike.
 */
export const FIT_FIRST = 10;

export type Shortage = { missing: Part[]; reason: string };

export type PlateInput = {
  date: string;
  slot: string;
  occasion: Occasion;
  /** The slot's time is not known (the template then follows the anchor). */
  untimed?: boolean;
  target: Macros;
  foods: readonly Food[] | Readonly<Record<string, Food>>;
  /** The account's own history from the snapshot (O2). Absent: curated evidence only. */
  evidence?: MealEvidence;
  /** The account's quantized taste values (pref-2, D8). Absent or empty: no taste term (pref-0). */
  taste?: TasteValues;
  /** The open food-world search (W8). Absent: the Phase 17 search. */
  open?: OpenRanking;
  /**
   * D7/W11 "shopping focus": the account turned on "use my shopping list". Domain-agnostic by
   * design (plate.ts never reads a shopping table itself) — the caller (lib/foods/layout-plan.ts)
   * supplies a coverage function already closed over the account's current used lines and pantry
   * items (lib/shopping/focus.ts `coverageOf`). Absent: unchanged, Phase-17-and-after ranking.
   */
  focus?: FocusRanking;
  /** The account's stated cuisines (lib/meals/cuisine.ts): a plate-score factor >= 1, ranking
   *  only. Absent: no factor, every plate unchanged. */
  cuisine?: CuisineRanking;
};

export type FocusRanking = {
  /** The share (0 to 1, in steps of 0.25) of these items' calories that count as "on the list or
   *  in the pantry right now" — `key` is the same identity `foodKey` gives each plate row's food. */
  coverageOf: (items: readonly { key: string; kcal: number }[]) => number;
};

export type PlateRanking = { plates: Plate[]; shortage: Shortage | null };

/** Side candidates kept per part before combining; more only grows the search. The carbs
 *  change the plate's character, so two of each are compared; the rest take their best one. */
const SIDES_PER_PART: Record<Part, number> = { anchor: 1, starch: 2, fruit: 2, veg: 1, fat: 1, protein: 1 };
const MAX_ITEMS = 5;
/** How far the date rotation can lower an anchor's score: enough to vary near-equal days. */
const ANCHOR_ROTATION = 0.3;
/** A fruit-and-fat snack (no anchor) is offered only for a small snack target. */
/** The anchorless snack template's only occasion: a small target, same rule for a pinned plate. */
export const SMALL_SNACK_KCAL = 350;
/** The widened shortlist per part: enough to get past unservable sides, bounded for speed. */
const WIDE_SIDES = 6;
/** A main without the vegetable Eats offers: ranked lower, kept for a tight protein target. */
const NO_VEG = 0.6;
const SIDE_PARTS: readonly Part[] = ["starch", "fruit", "veg", "fat", "protein"];

type Candidate = { food: Food; score: number };

const rotationOf = (date: string) => {
  const day = daysSinceEpoch(date);
  return Number.isFinite(day) ? day : 0;
};

function rotate<T>(items: readonly T[], by: number): T[] {
  if (!items.length) return [];
  const start = ((by % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/**
 * The pool's foods that can play each part, in pool order (computed once per ranking), each list
 * with an interned id of its ordered names: the side ranking below depends on nothing else.
 */
type PartPool = { foods: readonly Food[]; id: number };
type PartPools = ReadonlyMap<Part, PartPool>;

const POOL_IDS = new Map<string, number>();
function poolId(foods: readonly Food[]): number {
  const signature = foods.map((food) => food.name).join("\u0001");
  let id = POOL_IDS.get(signature);
  if (id === undefined) {
    if (POOL_IDS.size > 2_000) { POOL_IDS.clear(); SIDE_ORDER.clear(); }
    id = POOL_IDS.size + 1;
    POOL_IDS.set(signature, id);
  }
  return id;
}

function partPools(pool: readonly Food[]): PartPools {
  return new Map(SIDE_PARTS.map((part) => {
    const foods = pool.filter((food) => partsOf(food).includes(part) && carriesPart(food, part));
    return [part, { foods, id: poolId(foods) }];
  }));
}

/**
 * A part pool's sides for one anchor, scored and sorted (positions into the pool, best first): a
 * pure function of the pool's names, the anchor's name, the part, the template and the occasion
 * (`pairScore` reads names only), so it is remembered by exactly those, bounded. The same pool is
 * ranked again for every slot of a day.
 */
const SIDE_ORDER = new Map<string, { at: number; score: number }[]>();
function sideOrder(anchor: Food | null, pool: PartPool, part: Part, template: TemplateKey,
  occasion: Occasion): { at: number; score: number }[] {
  const key = `${pool.id}\u0001${anchor ? anchor.name : "\u0000"}\u0001${part}\u0001${template}\u0001${occasion}`;
  const hit = SIDE_ORDER.get(key);
  if (hit) return hit;
  if (SIDE_ORDER.size > 20_000) SIDE_ORDER.clear();
  const anchorKey = anchor ? foodKey(anchor) : null;
  const order = pool.foods.map((food, at) => ({ food, at }))
    .filter(({ food }) => anchorKey === null || foodKey(food) !== anchorKey)
    .map(({ food, at }) => ({ food, at, score: pairScore(anchor, food, part, template, occasion).score }))
    .filter((row) => row.score >= PAIR_FLOOR)
    .sort((a, b) => b.score - a.score || byCode(foodKey(a.food), foodKey(b.food)))
    .map(({ at, score }) => ({ at, score }));
  SIDE_ORDER.set(key, order);
  return order;
}

/** Coherent side foods for a part, best pairing first, the near-ties rotated by date. */
function sideCandidates(anchor: Food | null, pools: PartPools, part: Part, template: TemplateKey,
  occasion: Occasion, day: number, limit = SIDES_PER_PART[part]): Candidate[] {
  const pool = pools.get(part);
  if (!pool) return [];
  const scored = sideOrder(anchor, pool, part, template, occasion)
    .map(({ at, score }) => ({ food: pool.foods[at], score }));
  if (!scored.length) return [];
  const top = scored.filter((row) => row.score >= scored[0].score - 0.15);
  return [...rotate(top, day + part.length), ...scored.slice(top.length)].slice(0, limit);
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

const LEAD_WITH_FRUIT = new Set(["greek yogurt", "cottage cheese", "protein shake"]);
const COOKING_FAT = /\b(?:oil|butter|ghee|lard)\b/i;

/** The dish's name: the anchor and its main sides ("Greek yogurt with berries and granola"). */
export function plateName(rows: readonly PlateRow[], template: TemplateKey): string {
  const anchor = rows.find((row) => row.part === "anchor");
  const family = anchor ? mealFamily(anchor.food.name)?.key ?? "" : "";
  const order: Part[] = template !== "main" && LEAD_WITH_FRUIT.has(family)
    ? ["fruit", "starch", "veg", "protein"] : ["starch", "fruit", "veg", "protein"];
  const sides = rows.filter((row) => row.part !== "anchor" && row.part !== "fat")
    .sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part));
  const named = sides.slice(0, 2);
  const fat = rows.find((row) => row.part === "fat" && !COOKING_FAT.test(row.food.name));
  if (named.length < 2 && fat) named.push(fat);
  const lead = anchor ?? named.shift();
  if (!lead) return "Meal";
  // A second protein shares the head: "Greek yogurt and eggs with oats".
  const second = named.findIndex((row) => row.part === "protein");
  const partner = second >= 0 ? named.splice(second, 1)[0] : null;
  const words = named.map((row) => lowerFirst(displayName(row.food.name)));
  const head = partner ? `${displayName(lead.food.name)} and ${lowerFirst(displayName(partner.food.name))}`
    : displayName(lead.food.name);
  if (!words.length) return head;
  return `${head} with ${words.length === 1 ? words[0] : `${words[0]} and ${words[1]}`}`;
}

function combinations(options: readonly (Candidate | null)[][]): (Candidate | null)[][] {
  return options.reduce<(Candidate | null)[][]>((acc, list) =>
    acc.flatMap((combo) => list.map((option) => [...combo, option])), [[]]);
}

/** Every coherent, sized plate for one anchor (or the anchorless snack when `anchor` is null). */
function platesFor(anchor: Food | null, pool: PartPools, input: PlateInput, day: number,
  variety: number, wide = false, forced?: ReadonlyMap<Part, Food>): Plate[] {
  const anchorFamily = anchor ? mealFamily(anchor.name) : null;
  const key = anchor ? templateFor(input.occasion, input.untimed, anchorFamily?.usual ?? []) : "snack";
  const template: Template = anchor ? TEMPLATES[key] : ANCHORLESS_SNACK;
  const allowed = (part: Part) => !template.never.includes(part)
    && (template.optional.includes(part) || template.required.some((req) => req.includes(part)));
  const cands = new Map(SIDE_PARTS.map((part) => {
    // A pinned (W9 D12) side is forced into its named part: it bypasses the curated SHORTLIST
    // (`allowed`/`sideCandidates`, and the PAIR_FLOOR those apply) — a plate the user named
    // explicitly is never rejected for pairing alone — but never a coherence or policy check:
    // `unmetRequirements` and `coherentWhole` below still run on the row it produces, and its
    // REAL pairing (not a fake 1.0) still weighs the plate's score, so a named side that pairs
    // badly ranks honestly behind one that pairs well, exactly like any other row.
    const pin = forced?.get(part);
    if (pin) return [part, [{ food: pin, score: pairScore(anchor, pin, part, key, input.occasion).score }]];
    return [part, allowed(part) ? sideCandidates(anchor, pool, part, key, input.occasion, day,
      wide ? WIDE_SIDES : undefined) : []];
  }));
  if (anchor && !forced?.has("protein")) {
    // A second protein only when the anchor alone, at its band's top, falls short.
    const band = unitBand(anchor, "anchor");
    if (band && anchor.perUnit.protein * band.hi >= input.target.protein * 0.9) cands.set("protein", []);
  }
  const context = { anchorCarriesStarch: !!anchor && partsOf(anchor).includes("starch") };
  const vegPreferred = template.vegIfAvailable && (cands.get("veg") ?? []).length > 0;
  // A forced part is mandatory: dropping the pinned food from this combination is never an option.
  const options = SIDE_PARTS.map((part) =>
    forced?.has(part) ? (cands.get(part) ?? []) : [null, ...(cands.get(part) ?? [])]);
  const plates: Plate[] = [];
  for (const combo of combinations(options)) {
    const rows: PlateRow[] = anchor ? [{ food: anchor, part: "anchor" }] : [];
    combo.forEach((option, i) => { if (option) rows.push({ food: option.food, part: SIDE_PARTS[i] }); });
    if (rows.length > MAX_ITEMS || new Set(rows.map((row) => foodKey(row.food))).size !== rows.length) continue;
    if (unmetRequirements(template, rows.map((row) => row.part), context).length) continue;
    if (!coherentWhole(key, rows)) continue;
    if (input.open?.plateOk && !input.open.plateOk(rows.map((row) => row.food))) continue;
    const sized = sizePlate(rows, input.target);
    if (!sized) continue;
    const macros = totalOf(sized);
    const fit = macroFit(macros, input.target);
    const sides = combo.filter((option): option is Candidate => option !== null);
    const pairing = sides.length ? sides.reduce((sum, side) => sum + side.score, 0) / sides.length : 0.5;
    const aff = anchor ? affinity(anchor, input.occasion, input.untimed, input.evidence) : { score: 0.5, source: "neutral" as const };
    // A usual side (pairing 0.7+) completes the dish; a merely acceptable one is a small cost.
    const simplicity = sides.reduce((product, side) => product * (side.score >= 0.7 ? 1 : 0.97), 1);
    const veg = vegPreferred && !rows.some((row) => row.part === "veg") ? NO_VEG : 1;
    const base = fitWeight(macros, input.target) * aff.score * pairing * variety * simplicity * veg;
    const taste = hasTasteValues(input.taste) ? tasteMultiplier(sized.map((row) => ({ key: foodKey(row.food),
      amount: row.qty * macroKcal(row.food.perUnit) })), input.taste, input.occasion) : undefined;
    const fits = fitsTarget(macros, input.target);
    const cuisine = input.cuisine ? cuisineFactor(sized.map((row) => ({ food: row.food, part: row.part,
      kcal: row.component.macros.kcal })), key, input.cuisine) : 1;
    const ranked = (taste === undefined ? base : base * taste) * cuisine;
    const coverage = input.focus?.coverageOf(sized.map((row) => ({ key: foodKey(row.food),
      kcal: row.component.macros.kcal })));
    plates.push({
      key: rows.map((row) => row.food.id).join("+"), anchor, anchorKey: anchor ? foodKey(anchor) : null,
      occasion: input.occasion, template: key, rows: sized, components: sized.map((row) => row.component),
      macros, name: plateName(rows, key), fit, fits, affinity: aff, pairing,
      score: input.open && fits ? FIT_FIRST + ranked : ranked, ...(taste === undefined ? {} : { taste }),
      ...(coverage === undefined ? {} : { coverage }),
    });
  }
  // The shortlist keeps the best-paired sides; when none of them can be served (a 485 kcal meal
  // pack whose band is under one unit), widen to every side before calling the slot short
  // (GPT-6 Sol O1 audit, BLOCK 4).
  if (!plates.length && !wide) return platesFor(anchor, pool, input, day, variety, true, forced);
  return plates;
}

/**
 * Among plates that already fit the slot, the calorie/carb/fat shape is a near-tie so occasion
 * and pairing decide (oats with berries over rice with edamame at 07:30). A protein shortfall
 * always keeps its full penalty.
 */
function fitWeight(macros: Macros, target: Macros): number {
  const shape = shapeFit(macros, target);
  return proteinFit(macros, target) * (fitsTarget(macros, target) ? 0.7 + 0.3 * shape : 0.7 * shape);
}

export const byScore = (a: Plate, b: Plate) => b.score - a.score || byCode(a.key, b.key);
/**
 * D7/W11: "ranks plates by the key (fits the slot, coverage, score)" while shopping focus is on
 * — `fits` ahead of `coverage` ahead of the engine's own score, for every account alike (not just
 * an open one's existing fit-first bonus). `byScore` alone, unchanged, when `focus` is absent.
 */
export const byFocus = (a: Plate, b: Plate) =>
  Number(b.fits) - Number(a.fits) || (b.coverage ?? 0) - (a.coverage ?? 0) || byScore(a, b);

/** Why no plate could be built: the parts the best-suited anchor still lacks. */
function shortageFor(anchors: readonly Food[], pool: PartPools, input: PlateInput,
  day: number): Shortage {
  if (!anchors.length) return { missing: ["anchor"], reason: shortageReason(input.occasion, ["anchor"]) };
  const best = [...anchors].sort((a, b) => affinity(b, input.occasion, input.untimed, input.evidence).score
    - affinity(a, input.occasion, input.untimed, input.evidence).score || byCode(foodKey(a), foodKey(b)))[0];
  const key = templateFor(input.occasion, input.untimed, mealFamily(best.name)?.usual ?? []);
  const template = TEMPLATES[key];
  const present: Part[] = ["anchor", ...SIDE_PARTS.filter((part) =>
    sideCandidates(best, pool, part, key, input.occasion, day).length > 0)];
  const unmet = unmetRequirements(template, present, {
    anchorCarriesStarch: partsOf(best).includes("starch"),
  });
  const missing = [...new Set(unmet.flat())];
  if (missing.length) return { missing, reason: shortageReason(input.occasion, missing) };
  // The parts are there but none goes together at breakfast (yogurt beside rice only): name the
  // base it needs rather than a portion problem (GPT-6 Sol O1 round 2, finding 13).
  if ((key === "breakfast" || key === "snack") && present.includes("starch")) {
    return { missing: ["starch"], reason: "No bread, porridge or cereal fits this meal yet — try another food" };
  }
  return { missing: [], reason: "No plate fits this meal inside usual portions" };
}

/**
 * The anchors an open search tries for this slot (D11): every anchor when there are at most
 * `limit`; otherwise the best half by affinity × e^z (the account's taste at this occasion), then
 * the rest of the shortlist rotated by date from the others, so every admitted anchor takes turns.
 * Kept in pool order.
 */
function openAnchors(all: readonly Food[], input: PlateInput, limit: number, day: number): Food[] {
  if (all.length <= limit) return [...all];
  const keyOf = (anchor: Food) => affinity(anchor, input.occasion, input.untimed, input.evidence).score
    * Math.exp(tasteZ(input.taste, foodKey(anchor), input.occasion));
  const ranked = [...all].sort((a, b) => keyOf(b) - keyOf(a) || byCode(foodKey(a), foodKey(b)) || byCode(a.id, b.id));
  const best = Math.ceil(limit / 2);
  const chosen = new Set([...ranked.slice(0, best), ...rotate(ranked.slice(best), day).slice(0, limit - best)]);
  return all.filter((anchor) => chosen.has(anchor));
}

/** Ranked coherent plates for one slot, best first, or the shortage that stops them. */
export function rankPlates(input: PlateInput): PlateRanking {
  const pool = generationPool(input.foods);
  const pools = partPools(pool);
  const day = rotationOf(input.date);
  const all = poolAnchors(pool);
  const searched = input.open ? openAnchors(all, input, input.open.anchorLimit, day) : all;
  // The date rotates anchors within their own affinity tier, so the foods that suit this meal
  // take turns (eggs, yogurt, a shake at breakfast) instead of one always winning.
  const tierOf = (anchor: Food) => affinity(anchor, input.occasion, input.untimed, input.evidence).score;
  const plates = searched.flatMap((anchor) => {
    const tier = searched.filter((other) => tierOf(other) === tierOf(anchor));
    const variety = 1 - ANCHOR_ROTATION * (((tier.indexOf(anchor) + day) % tier.length) / tier.length);
    return platesFor(anchor, pools, input, day, variety);
  });
  if (input.occasion === "snack" && input.target.kcal <= SMALL_SNACK_KCAL) plates.push(...platesFor(null, pools, input, day, 0.9));
  plates.sort(input.focus ? byFocus : byScore);
  return plates.length ? { plates, shortage: null }
    : { plates, shortage: shortageFor(all, pools, input, day) };
}

/**
 * Every way to assign a set of pinned foods to distinct plate parts, each food restricted to a
 * part it can actually play (`partsOf`). One pinned food may be the anchor; the rest are forced
 * sides. Order doesn't matter for scoring (every assignment is tried, D12's "enumerates the pinned
 * foods' part assignments"), only that no two foods claim the same part.
 */
function pinnedAssignments(pinned: readonly Food[]): ReadonlyMap<Part, Food>[] {
  if (pinned.length === 0) return [new Map()];
  const [food, ...rest] = pinned;
  const parts = partsOf(food);
  const tails = pinnedAssignments(rest);
  const out: Map<Part, Food>[] = [];
  for (const part of parts) {
    for (const tail of tails) {
      if (tail.has(part)) continue;
      out.push(new Map([...tail, [part, food]]));
    }
  }
  return out;
}

/**
 * The pinned, one-slot entry (Phase 18 W9, D12): every coherent plate that holds every food in
 * `pinned`, ranked exactly like `rankPlates` (same template, coherence, sizing and score —
 * including an open account's taste term and meal-level plate rule). A pinned food bypasses the
 * curated side shortlist (`sideCandidates`) AND the shortlist's own `PAIR_FLOOR` (D12's stated
 * exception, W9 Sol re-plan round 3): its real pairing still weighs the plate's score, but never
 * rejects it outright — only `template.never`, `unmetRequirements`, `coherentWhole`, the
 * meal-level plate rule or a `sizePlate` failure can. When no pinned food takes the anchor, every
 * admitted anchor is tried with the pinned sides forced (D12 "fills missing parts from the
 * admitted pool" covers the anchor part too), plus the anchorless snack template under the same
 * small-snack gate `rankPlates` already applies. An assignment that cannot form one coherent,
 * sized plate contributes nothing, and `rankPinnedPlates` never falls back to plain `rankPlates`
 * results — the caller (`lib/coach/compose-pinned.ts`) reports an incomplete named draft when
 * this comes back empty, never a plate that drops a named food.
 *
 * With no pinned foods this is exactly `rankPlates`.
 */
export function rankPinnedPlates(input: PlateInput, pinned: readonly Food[]): PlateRanking {
  if (pinned.length === 0) return rankPlates(input);
  const pool = generationPool(input.foods);
  const pools = partPools(pool);
  const day = rotationOf(input.date);
  const anchors = poolAnchors(pool);
  // The anchorless snack template is a small-snack-only special case for `rankPlates` (D4); a
  // named combination gets no looser a rule just for being user-chosen (W9 re-plan, round 3):
  // "apple with peanut butter" is coherent at a snack target, not silently approved as a dinner.
  const anchorlessOk = input.occasion === "snack" && input.target.kcal <= SMALL_SNACK_KCAL;
  const plates = pinnedAssignments(pinned).flatMap((assignment) => {
    const sides = new Map(assignment);
    sides.delete("anchor");
    const pinnedAnchor = assignment.get("anchor");
    // No shortlist rotation for a named plate: every assignment is tried on its own merits, not
    // taking turns with other anchors (that's a `rankPlates` shortlist-quality concern only).
    if (pinnedAnchor) return platesFor(pinnedAnchor, pools, input, day, 1, false, sides);
    // No pinned food takes the anchor: D12 "fills missing parts from the admitted pool" includes
    // the anchor part too (a wish naming only a starch, e.g. "rice", still needs one) — try every
    // admitted anchor with the pinned sides forced, plus the anchorless template where allowed.
    return [
      ...anchors.flatMap((anchor) => platesFor(anchor, pools, input, day, 1, false, sides)),
      ...(anchorlessOk ? platesFor(null, pools, input, day, 1, false, sides) : []),
    ];
  });
  plates.sort(input.focus ? byFocus : byScore);
  return plates.length ? { plates, shortage: null }
    : { plates: [], shortage: { missing: [], reason: "No coherent plate holds every named food" } };
}

/** The best plate per anchor, best first: the distinct choices a person compares. */
export function bestPerAnchor(plates: readonly Plate[]): Plate[] {
  const seen = new Set<string>();
  return plates.filter((plate) => {
    const key = plate.anchorKey ?? `none:${plate.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
