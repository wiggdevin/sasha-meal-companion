/**
 * Eaten history and choice episodes (Phase 18 D5, slice W3): the arithmetic only.
 *
 * Input is already reduced by the server read (lib/server/taste-history.ts) to eaten items, each
 * with its identity (lib/meals/taste-identity.ts), its local date, the meal slot it was eaten in
 * and the source row kind; plus choice events. Nothing is stored: history is computed on read, so
 * an edit, a move or a delete is right on the next read with no backfill.
 *
 * One eating episode is one (local date, meal slot): a consumed recipe, its eaten slot and any log
 * for the same meal are ONE episode, and inside it each identity counts once (Sol W3). Every
 * collapsed duplicate is kept in the provenance, so each count can say where it came from.
 *
 *   H_f  distinct eaten days in 180, each day weighted 2^(−age/45) × the day's match weight
 *   Q_f  chosen or added events in 180 (a manual shopping line today; swap picks and Plan-sheet
 *        adds arrive with W6's signal events), each × its match weight
 *   M    independent episodes, at most 4 a day, each weighted 2^(−age/90) (drives the D8 fade)
 *
 * Match weight: a universe item 1, a name family 0.5; a mixed dish's estimated input another × 0.5.
 *
 * Exceptions (owner item 1): only identities in `admitted` (current verdict `allowed`, not on
 * Avoid) contribute anything, to H, Q or M. Items under 10 g and non-countable universe items add
 * nothing. History itself is never edited: when a rule goes, the same rows count again.
 *
 * Pure. No I/O.
 */

import { countableIdentity, type TasteIdentity, type TasteMatch } from "@/lib/meals/taste-identity";

export const TASTE_VERSION = "taste-1";
export const TASTE_WINDOW_DAYS = 180;
export const H_HALF_LIFE_DAYS = 45;
export const M_HALF_LIFE_DAYS = 90;
export const M_DAILY_CAP = 4;
export const MIN_GRAMS = 10;
export const FAMILY_WEIGHT = 0.5;
export const ESTIMATED_WEIGHT = 0.5;

export type TasteSource = "log" | "recipe" | "tick" | "mixed_dish";
export const TASTE_SOURCES: readonly TasteSource[] = ["log", "recipe", "tick", "mixed_dish"];
export type ChoiceKind = "swap_pick" | "plan_add" | "shopping_manual";
export const CHOICE_KINDS: readonly ChoiceKind[] = ["swap_pick", "plan_add", "shopping_manual"];

export type EatenItem = {
  localDate: string;
  /** The meal slot (`meal-2`) the food was eaten in; with the date, the episode. */
  slot: string;
  source: TasteSource;
  identity: TasteIdentity;
  /** Eaten grams; null when the mass is unknown (a unit of an own food), which still counts. */
  grams: number | null;
  /** A mixed dish's FNDDS input (W4): an estimate of the dish, not its exact recipe. */
  estimated?: boolean;
};

export type ChoiceEvent = { localDate: string; kind: ChoiceKind; identity: TasteIdentity };

export type TasteProvenance = {
  match: TasteMatch;
  /** True when any counted day rests only on a mixed dish's estimated inputs. */
  estimated: boolean;
  /** Episodes in which each source kind supplied this identity. */
  sources: Record<TasteSource, number>;
  /** Duplicate occurrences folded into an episode that already counted this identity. */
  collapsed: number;
  choices: Record<ChoiceKind, number>;
};

export type IdentityTaste = {
  key: string; name: string;
  h: number; q: number;
  days180: number; episodes: number;
  /** The latest eaten date in the window, or null when only choices name it. */
  lastOn: string | null;
  provenance: TasteProvenance;
};

export type TasteResult = {
  version: typeof TASTE_VERSION;
  today: string;
  windowStart: string;
  /** M: the account's weighted independent choice episodes. */
  m: number;
  /** Episodes counted into M, unweighted (after the daily cap). */
  episodes: number;
  /** Highest H first, then Q, then key. */
  identities: IdentityTaste[];
};

export type TasteInput = {
  today: string;
  items: readonly EatenItem[];
  choices: readonly ChoiceEvent[];
  /** Identity keys whose current verdict is `allowed` and that no Avoid mark covers. */
  admitted: ReadonlySet<string>;
};

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN;
}

/** The first local date inside the 180-day window ending on `today` (both inclusive). */
export function tasteWindowStart(today: string): string {
  return new Date((dayNumber(today) - (TASTE_WINDOW_DAYS - 1)) * DAY_MS).toISOString().slice(0, 10);
}

/** Four decimals: the same number on every runtime. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function matchWeight(identity: TasteIdentity, estimated = false): number {
  return (identity.match === "universe" ? 1 : FAMILY_WEIGHT) * (estimated ? ESTIMATED_WEIGHT : 1);
}

/** Whether an item may count at all: a real amount of at least 10 g (or unknown), and countable. */
export function countableItem(item: EatenItem): boolean {
  if (item.grams !== null && !(Number.isFinite(item.grams) && item.grams >= MIN_GRAMS)) return false;
  return countableIdentity(item.identity);
}

/**
 * A mixed dish's items: its FNDDS inputs at half weight, marked estimated, when they are known
 * (W4 loads them); else the dish itself, by its own identity. `inputs` grams are per gram of dish.
 */
export function mixedDishItems(dish: Omit<EatenItem, "source" | "estimated">,
  inputs: readonly { identity: TasteIdentity; gramsPerGram: number }[] | undefined): EatenItem[] {
  if (!inputs?.length) return [{ ...dish, source: "mixed_dish" }];
  return inputs.map((input) => ({ ...dish, source: "mixed_dish" as const, identity: input.identity,
    estimated: true, grams: dish.grams === null ? null : dish.grams * input.gramsPerGram }));
}

type Acc = {
  identity: TasteIdentity; nameDate: string;
  /** Per counted day, its best occurrence (a non-estimated one wins a tie). */
  best: Map<number, { weight: number; estimated: boolean }>; episodes: Set<string>;
  sources: Record<TasteSource, Set<string>>; collapsed: number; q: number;
  choices: Record<ChoiceKind, number>;
};

function emptyAcc(identity: TasteIdentity): Acc {
  return { identity, nameDate: "", best: new Map(), episodes: new Set(),
    sources: { log: new Set(), recipe: new Set(), tick: new Set(), mixed_dish: new Set() },
    collapsed: 0, q: 0, choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 } };
}

/** The shown name: the latest occurrence's, ties broken by the smaller name. */
function rename(acc: Acc, identity: TasteIdentity, date: string): void {
  if (date > acc.nameDate || (date === acc.nameDate && identity.name < acc.identity.name)) {
    acc.identity = { ...acc.identity, name: identity.name };
    acc.nameDate = date;
  }
}

export function tasteProfile(input: TasteInput): TasteResult {
  const end = dayNumber(input.today);
  const windowStart = tasteWindowStart(input.today);
  const inWindow = (day: number) => Number.isFinite(day) && day <= end && day > end - TASTE_WINDOW_DAYS;
  const accs = new Map<string, Acc>();
  const accFor = (identity: TasteIdentity) => {
    const hit = accs.get(identity.key) ?? emptyAcc(identity);
    accs.set(identity.key, hit);
    return hit;
  };
  const seenInEpisode = new Set<string>();
  const episodeDays = new Map<string, number>();
  const ordered = [...input.items].sort((a, b) => cmp(itemOrder(a), itemOrder(b)));
  for (const item of ordered) {
    const day = dayNumber(item.localDate);
    if (!inWindow(day) || !input.admitted.has(item.identity.key) || !countableItem(item)) continue;
    const episode = `${item.localDate}\u0000${item.slot}`;
    episodeDays.set(episode, day);
    const acc = accFor(item.identity);
    rename(acc, item.identity, item.localDate);
    acc.episodes.add(episode);
    acc.sources[item.source].add(episode);
    const once = `${episode}\u0000${item.identity.key}`;
    if (seenInEpisode.has(once)) acc.collapsed += 1;
    else seenInEpisode.add(once);
    const weight = matchWeight(item.identity, item.estimated === true);
    const estimated = item.estimated === true;
    const best = acc.best.get(day);
    if (!best || weight > best.weight || (weight === best.weight && best.estimated && !estimated)) {
      acc.best.set(day, { weight, estimated });
    }
  }
  for (const choice of input.choices) {
    const day = dayNumber(choice.localDate);
    if (!inWindow(day) || !input.admitted.has(choice.identity.key)) continue;
    if (!countableIdentity(choice.identity)) continue;
    const acc = accFor(choice.identity);
    if (!acc.nameDate) rename(acc, choice.identity, choice.localDate);
    acc.q += matchWeight(choice.identity);
    acc.choices[choice.kind] += 1;
  }
  const perDay = new Map<number, number>();
  for (const day of episodeDays.values()) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  let m = 0;
  let episodes = 0;
  for (const [day, count] of perDay) {
    const capped = Math.min(count, M_DAILY_CAP);
    episodes += capped;
    m += capped * 0.5 ** ((end - day) / M_HALF_LIFE_DAYS);
  }
  const identities = [...accs.values()].map((acc): IdentityTaste => {
    const days = [...acc.best.keys()];
    const h = days.reduce((sum, day) => sum + (acc.best.get(day)?.weight ?? 0)
      * 0.5 ** ((end - day) / H_HALF_LIFE_DAYS), 0);
    const last = days.length ? Math.max(...days) : null;
    return {
      key: acc.identity.key, name: acc.identity.name, h: round(h), q: round(acc.q),
      days180: days.length, episodes: acc.episodes.size,
      lastOn: last === null ? null : new Date(last * DAY_MS).toISOString().slice(0, 10),
      provenance: {
        match: acc.identity.match,
        estimated: days.some((day) => acc.best.get(day)?.estimated === true),
        sources: { log: acc.sources.log.size, recipe: acc.sources.recipe.size,
          tick: acc.sources.tick.size, mixed_dish: acc.sources.mixed_dish.size },
        collapsed: acc.collapsed, choices: { ...acc.choices },
      },
    };
  }).sort((a, b) => b.h - a.h || b.q - a.q || cmp(a.key, b.key));
  return { version: TASTE_VERSION, today: input.today, windowStart, m: round(m), episodes, identities };
}

const SOURCE_ORDER: Record<TasteSource, number> = { recipe: 0, tick: 1, log: 2, mixed_dish: 3 };

/** Stable order: date, slot, source (recipe before its slot before a log), identity, grams. */
function itemOrder(item: EatenItem): string {
  return [item.localDate, item.slot, SOURCE_ORDER[item.source], item.identity.key,
    item.estimated ? 1 : 0, String(item.grams ?? -1).padStart(12, "0")].join("\u0000");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
