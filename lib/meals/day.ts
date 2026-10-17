/**
 * A whole day of generated plates (Phase 17 O1, D5): one plate per slot from `rankPlates`, with
 * distinct anchors across the day preferred. An anchor may repeat only when the day cannot be
 * filled otherwise (Eats has fewer anchors than slots, or an anchor has no coherent plate at some
 * slot), and never in two neighbouring slots. A slot nothing can fill gets the shortage reason
 * `rankPlates` gives for it, so the notice and the generator are one computation.
 *
 * Pure. No I/O. Deterministic for a date.
 */

import type { Food } from "@/lib/foods";
import type { Macros, SlotId } from "@/lib/types";
import { clockMinutes, isUntimed, occasionAt, type Occasion, type OccasionOverrides } from "@/lib/meals/occasion";
import {
  bestPerAnchor, byFocus, byScore, rankPlates, type FocusRanking, type OpenRanking, type Plate, type Shortage,
} from "@/lib/meals/plate";
import { byCode } from "@/lib/meals/parts";
import { generationPool } from "@/lib/meals/pool";
import { hasTasteValues, type TasteValues } from "@/lib/meals/preference";
import { SUGGESTIONS_NEED_CONNECTION, type MealEvidence } from "@/lib/meals/snapshot";
import type { CuisineRanking } from "@/lib/meals/cuisine";

export type DaySlot = { id: SlotId; target: Macros; clock?: string | null; occasion?: Occasion };
export type DayPlan = {
  plates: { slot: SlotId; plate: Plate }[];
  shortages: { slot: SlotId; shortage: Shortage }[];
  /** Slots whose closest plate inside the bands still misses the target, and why (D5). */
  misses: { slot: SlotId; reason: string }[];
};

/** Why the closest plate misses: protein first, since protein leads every plate. */
export function missReason(plate: Plate, target: Macros): string | null {
  if (plate.fits) return null;
  return plate.macros.protein < target.protein * 0.9
    ? "These foods can’t reach this meal’s protein in usual portions"
    : "These foods can’t match this meal’s calories in usual portions";
}

const REPEAT = 0.5;
const EMPTY = -1;
/** Above this many assignments a short day is assigned (distinct first) instead of searched. */
const SEARCH_LIMIT = 200_000;

type Choice = Map<string, Plate>;

/**
 * W11 (D7) shopping focus: the day honours the key (fits the slot, coverage, score) slot by slot.
 * The weights make one step of coverage (0.25) outweigh any day's whole score sum, and a fit
 * outweigh any day's whole coverage, so the day search can trade score only among plates of equal
 * fit and coverage. A repeat halves only the score part: a covered repeat still beats an uncovered
 * distinct plate, and distinct anchors still win among equally covered plates.
 */
const FOCUS_FIT_WEIGHT = 1e6;
const FOCUS_COVERAGE_WEIGHT = 1e4;

/** A plate's worth to the day search: its score, or under focus the key above as one number. */
type PlateValue = (plate: Plate, repeat: boolean) => number;
const scoreValue: PlateValue = (plate, repeat) => plate.score * (repeat ? REPEAT : 1);
const focusValue: PlateValue = (plate, repeat) => (plate.fits ? FOCUS_FIT_WEIGHT : 0)
  + (plate.coverage ?? 0) * FOCUS_COVERAGE_WEIGHT + plate.score * (repeat ? REPEAT : 1);

/**
 * A061 "Quick meals" (owner decision 2026-10-11): the date is marked quick, so a plate that fits
 * the slot AND is ready inside `maxMinutes` ranks ahead of every other plate; below that, the
 * day's own order (score, or the focus key) is unchanged. A quick plate that misses the slot's
 * fit (protein below 90 %, or calories outside 10 %) gains nothing, so protein never softens and a
 * slot with no quick plate that fits keeps exactly the plate it had. Domain-agnostic like `focus`:
 * the caller (lib/foods/layout-plan.ts) supplies the minutes rule (lib/plan/prep-minutes.ts).
 * Ranking only: the pool, admission and every food's verdict are untouched.
 */
export type QuickRanking = {
  maxMinutes: number;
  minutesOf: (foods: readonly Food[]) => number;
};
/** Above any day's whole sum of the lower terms (fit 1e6 + coverage + score per slot). */
const QUICK_FIT_WEIGHT = 1e9;

/** The quick key for one plate: true when it fits the slot and is ready in time. */
function quickFit(quick: QuickRanking): (plate: Plate) => boolean {
  const seen = new Map<Plate, boolean>();
  return (plate) => {
    let value = seen.get(plate);
    if (value === undefined) {
      value = plate.fits && quick.minutesOf(plate.rows.map((row) => row.food)) <= quick.maxMinutes;
      seen.set(plate, value);
    }
    return value;
  };
}

/** The day's slots in clock order (input order when any clock is unknown). */
function inClockOrder(slots: readonly DaySlot[]): DaySlot[] {
  if (slots.some((slot) => clockMinutes(slot.clock) === null)) return [...slots];
  return slots.map((slot, index) => ({ slot, index }))
    .sort((a, b) => (clockMinutes(a.slot.clock) ?? 0) - (clockMinutes(b.slot.clock) ?? 0) || a.index - b.index)
    .map((row) => row.slot);
}

/** Exhaustive best assignment with no equal neighbours; distinct anchors win over repeats. */
function search(choices: Choice[], value: PlateValue = scoreValue, empty = EMPTY): (string | null)[] {
  const n = choices.length;
  const options = choices.map((choice) => [...choice.keys()].sort());
  const best = choices.map((choice) => Math.max(0, ...[...choice.values()].map((plate) => value(plate, false))));
  let top = Number.NEGATIVE_INFINITY;
  let answer: (string | null)[] = choices.map(() => null);
  const picked: (string | null)[] = [];
  const uses = new Map<string, number>();
  const walk = (i: number, total: number) => {
    if (i === n) {
      if (total > top + 1e-12) { top = total; answer = [...picked]; }
      return;
    }
    const bound = total + best.slice(i).reduce((sum, value) => sum + value, 0);
    if (bound <= top + 1e-12) return;
    for (const key of options[i]) {
      if (picked[i - 1] === key) continue;
      const used = uses.get(key) ?? 0;
      picked[i] = key;
      uses.set(key, used + 1);
      walk(i + 1, total + value(choices[i].get(key) as Plate, used > 0));
      uses.set(key, used);
    }
    picked[i] = null;
    walk(i + 1, total + empty);
  };
  walk(0, 0);
  return answer;
}

/**
 * Best distinct assignment (Hungarian method, rows = slots, columns = anchors, rows ≤ columns):
 * the day whose plates score highest in total with no anchor twice. Then any slot left without
 * a plate takes its best anchor that neither neighbour has (a repeat, D5).
 */
function assign(choices: Choice[], value: PlateValue = scoreValue): (string | null)[] {
  const keys = [...new Set(choices.flatMap((choice) => [...choice.keys()]))].sort();
  const rows = choices.length;
  const cols = Math.max(keys.length, rows);
  // Cost of a slot taking an anchor: minus its score; no plate there costs more than any plate.
  const cost = (r: number, c: number) => {
    const plate = c < keys.length ? choices[r].get(keys[c]) : undefined;
    return plate ? -value(plate, false) : 1;
  };
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const match = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);
  for (let r = 1; r <= rows; r += 1) {
    match[0] = r;
    let c0 = 0;
    const minv = new Array<number>(cols + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[c0] = true;
      const r0 = match[c0];
      let delta = Number.POSITIVE_INFINITY;
      let c1 = 0;
      for (let c = 1; c <= cols; c += 1) {
        if (used[c]) continue;
        const cur = cost(r0 - 1, c - 1) - u[r0] - v[c];
        if (cur < minv[c]) { minv[c] = cur; way[c] = c0; }
        if (minv[c] < delta) { delta = minv[c]; c1 = c; }
      }
      for (let c = 0; c <= cols; c += 1) {
        if (used[c]) { u[match[c]] += delta; v[c] -= delta; } else minv[c] -= delta;
      }
      c0 = c1;
    } while (match[c0] !== 0);
    do { const c1 = way[c0]; match[c0] = match[c1]; c0 = c1; } while (c0);
  }
  const answer: (string | null)[] = choices.map(() => null);
  for (let c = 1; c <= cols; c += 1) {
    const r = match[c] - 1;
    if (r >= 0 && c - 1 < keys.length && choices[r].has(keys[c - 1])) answer[r] = keys[c - 1];
  }
  choices.forEach((choice, slot) => {
    if (answer[slot] !== null) return;
    const ranked = [...choice.entries()].sort((a, b) => value(b[1], false) - value(a[1], false) || byCode(a[0], b[0]));
    answer[slot] = ranked.find(([key]) => answer[slot - 1] !== key && answer[slot + 1] !== key)?.[0] ?? null;
  });
  return answer;
}

/** The day's plate per slot (null: nothing can fill it), from the anchored choices. */
function pickDay(choices: Choice[], rankings: readonly { plates: Plate[] }[], value: PlateValue,
  order: (a: Plate, b: Plate) => number): (Plate | null)[] {
  // Search whenever it is affordable, so a much better repeated protein (half score, never in
  // neighbouring slots) can beat a weak distinct one; above the limit, distinct first.
  const size = choices.reduce((product, choice) => product * (choice.size + 1), 1);
  const keys = size > SEARCH_LIMIT ? assign(choices, value) : search(choices, value);
  return choices.map((choice, i) => {
    const key = keys[i];
    if (key !== null) return choice.get(key) as Plate;
    // D5 (amended): a protein repeats in a neighbouring slot only when the other choice is an
    // empty slot. A repeated meal is better than no meal.
    return [...choice.values()].sort(order)[0]
      ?? rankings[i].plates.find((plate) => plate.anchorKey === null) ?? null;
  });
}

/**
 * A061: the quick day over the usual day `usual`. Each slot chooses between its fitting quick
 * plates (anchored ones by anchor, a fitting quick fruit-and-fat snack by its own key) and its
 * usual plate, never anything else: a slot ends quick or exactly as it was, so no slot without a
 * fitting quick plate changes and protein never drops below the usual plate's fit.
 */
function quickDay(usual: readonly (Plate | null)[], rankings: readonly { plates: Plate[] }[],
  isQuick: (plate: Plate) => boolean, value: PlateValue): (Plate | null)[] {
  const choices: Choice[] = rankings.map((ranking, i) => {
    // An anchorless snack has no protein to repeat: its key is the slot's own, so the neighbour
    // and repeat rules (protein rules, D5) never apply to it.
    const keyOf = (plate: Plate) => plate.anchorKey ?? `none:${i}:${plate.key}`;
    const choice: Choice = new Map();
    for (const plate of ranking.plates) {
      if (isQuick(plate) && !choice.has(keyOf(plate))) choice.set(keyOf(plate), plate);
    }
    const plate = usual[i];
    if (plate && !choice.has(keyOf(plate))) choice.set(keyOf(plate), plate);
    return choice;
  });
  // Nothing quick anywhere: the usual day, untouched (a same-anchor quick plate is not this case).
  if (choices.every((choice, i) => [...choice.values()].every((plate) => plate === usual[i]))) return [...usual];
  const quickValue: PlateValue = (plate, repeat) => (isQuick(plate) ? QUICK_FIT_WEIGHT : 0) + value(plate, repeat);
  const size = choices.reduce((product, choice) => product * (choice.size + 1), 1);
  // Every slot holds its usual plate as a choice, so an empty slot is never needed for the usual
  // day: leaving one empty costs more than any day can gain, and a slot is left empty (then given
  // its usual plate back) only when no assignment keeps neighbours apart.
  const keys = size > SEARCH_LIMIT ? assign(choices, quickValue)
    : search(choices, quickValue, -QUICK_FIT_WEIGHT * (choices.length + 1));
  return choices.map((choice, i) => (keys[i] === null ? usual[i] : choice.get(keys[i] as string) as Plate));
}

/**
 * Plan every slot of a day from this account's Eats.
 *
 * `evidence` is the account's snapshot evidence (O2, D2): `undefined` ranks on curated evidence
 * alone (a caller that has not adopted the snapshot); `null` means a snapshot was required and none
 * usable is held (offline, older than 7 days, or another account's), so no new suggestion is made
 * and every open slot says "Suggestions need a connection".
 *
 * `taste` is the account's quantized `pref-2` values (lib/meals/preference.ts); absent or empty, the day is
 * exactly the Phase 17 one (`pref-0`, closed food-world accounts).
 *
 * `open` is the open food-world search (W8, lib/meals/plate.ts `OpenRanking`); absent, the search is
 * the Phase 17 one. Only an open account's admitted pool (lib/meals/open-world.ts) passes it.
 *
 * `focus` is the account's active shopping focus for this date (W11, D7; lib/shopping/focus.ts
 * `focusRankingOn`): every slot ranks by (fits, coverage, score) and the day keeps that key per
 * slot. Absent: byte-identical to the day without it.
 *
 * `cuisine` is the account's stated cuisines (lib/meals/cuisine.ts): each plate's score takes its
 * cuisine factor. Absent (no cuisine stated): byte-identical to the day without it.
 *
 * `quick` is the date's "Quick meals" mark (A061, `QuickRanking` above): a quick plate that fits
 * wins its slot. Absent (the date is not marked): byte-identical to the day without it.
 */
export function planDay(date: string, slots: readonly DaySlot[],
  foods: readonly Food[] | Readonly<Record<string, Food>>, overrides?: OccasionOverrides,
  evidence?: MealEvidence | null, taste?: TasteValues, open?: OpenRanking, focus?: FocusRanking,
  cuisine?: CuisineRanking, quick?: QuickRanking): DayPlan {
  // A slot with no calories or no protein left to serve (an eaten recipe covered the day's
  // protein) gets no generated plate, as before O1: protein leads every plate.
  const ordered = inClockOrder(slots).filter((slot) => slot.target.kcal > 0 && slot.target.protein > 0);
  if (!ordered.length) return { plates: [], shortages: [], misses: [] };
  if (evidence === null) {
    return { plates: [], misses: [], shortages: ordered.map((slot) => ({ slot: slot.id,
      shortage: { missing: [], reason: SUGGESTIONS_NEED_CONNECTION } })) };
  }
  const pool = generationPool(foods);
  const inputs = ordered.map((slot) => {
    const occasion = slot.occasion ?? occasionAt(slot.clock, { slot: slot.id, overrides });
    return { date, slot: slot.id, occasion, untimed: isUntimed(occasion, slot.clock), target: slot.target,
      foods: pool, ...(evidence ? { evidence } : {}), ...(hasTasteValues(taste) ? { taste } : {}),
      ...(open ? { open, foodWorld: "open" as const } : {}), ...(focus ? { focus } : {}), ...(cuisine ? { cuisine } : {}) };
  });
  const rankings = inputs.map((input) => rankPlates(input));
  const choices: Choice[] = rankings.map((ranking) => new Map(bestPerAnchor(ranking.plates)
    .filter((plate) => plate.anchorKey !== null).map((plate) => [plate.anchorKey as string, plate])));
  const value = focus ? focusValue : scoreValue;
  const picked = pickDay(choices, rankings, value, focus ? byFocus : byScore);
  const final = quick ? quickDay(picked, rankings, quickFit(quick), value) : picked;

  const plan: DayPlan = { plates: [], shortages: [], misses: [] };
  ordered.forEach((slot, i) => {
    const plate = final[i];
    if (plate) {
      plan.plates.push({ slot: slot.id, plate });
      return;
    }
    // No anchored plate and no anchorless one means rankPlates found none and said why.
    const shortage = rankings[i].shortage
      ?? { missing: ["anchor"], reason: "No plate fits this meal inside usual portions" };
    plan.shortages.push({ slot: slot.id, shortage });
  });
  for (const { slot, plate } of plan.plates) {
    const target = ordered.find((row) => row.id === slot)?.target;
    const reason = target ? missReason(plate, target) : null;
    if (reason) plan.misses.push({ slot, reason });
  }
  return plan;
}
