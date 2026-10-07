/**
 * The coach's thread memory: a short list of typed preference items. No model sentence is stored
 * or replayed.
 *
 * Every item is `kind|value`. Non-food kinds are closed sets (a time, a portion shape, an enum).
 * A food value is valid ONLY when it grounds to a name the account itself holds (Eats or Avoid) or
 * an exact common-foods (`lib/food-db.json`) name, and the stored and rendered value is that
 * canonical name, never the model's spelling. The same grounding runs when an item is written
 * and when it is read back into the prompt, so a stored row that no longer grounds is dropped
 * item by item rather than replayed.
 *
 * The server owns the merge: this turn's valid items are unioned with the stored ones, newest
 * wins per kind+value (and per food across liked/disliked), and the list is capped by recency.
 */
import { z } from "zod";
import { FOOD_DB } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";

export const MEMORY_KINDS = ["liked_food", "disliked_food", "usual_meal_time",
  "portion_preference", "cuisine_preference", "goal_context"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryItem = { kind: MemoryKind; value: string };

/** `coach_threads_summary_len` (migration 20261020110000) caps the column at 600 characters. */
export const MEMORY_MAX_CHARS = 600;
export const MEMORY_MAX_ITEMS = 12;
export const FOOD_VALUE_MAX = 80;
/** The longest kind (18) + "|" + the longest food value, rounded up. */
export const MEMORY_WIRE_ENTRY_MAX = 100;

// Gemini's coach schema is already at its tested 30-property limit, so each wire entry is one
// string; this parser, not the model's prose, creates the typed item.
/**
 * The provider schema's array cap: `tests/coach/provider-schema.test.ts` bounds every provider
 * array at 11, so the wire cannot carry a full 12-item row. The prompt therefore shows at most this
 * many stored items (the newest), and the server keeps the rest (review t3r4 WARN 6).
 */
export const MEMORY_WIRE_MAX_ITEMS = 8;
// Gemini's coach schema is already at its tested 30-property limit, so each wire entry is one
// string; this parser, not the model's prose, creates the typed item.
export const memoryWireSchema = z.array(z.string().max(MEMORY_WIRE_ENTRY_MAX))
  .max(MEMORY_WIRE_MAX_ITEMS);
/**
 * What the turn parsers accept. A malformed, oversized or surplus entry is dropped here instead
 * of failing the whole step: memory is advisory, the reply and its actions are not.
 */
export const memoryParseSchema = z.preprocess(
  (value) => Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.length <= MEMORY_WIRE_ENTRY_MAX)
      .slice(0, MEMORY_MAX_ITEMS)
    : value,
  z.array(z.string()),
);
const STORED_PREFIX = "M1:";

const CUISINES = new Set(["american", "chinese", "indian", "italian", "japanese",
  "mediterranean", "mexican", "middle eastern", "thai", "vietnamese"]);
const GOALS = new Set(["convenience", "routine", "variety"]);
const FOOD_KINDS = new Set<MemoryKind>(["liked_food", "disliked_food"]);

// Ordinary catalog name characters: "Milk, 2%", "Rice (brown)", "Mac & cheese", "Cheese, cheddar".
// Grounding, not this class, is the safety gate; the class only keeps markup out of the prompt.
const FOOD_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} ,.%/()'&+-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const URL_LIKE = /:\/\/|\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|app|dev|ly|me|xyz)\b/i;
// A food name never addresses the reader. Unicode lookalikes are folded to Latin first: capitals
// by their own shape (Greek Η is "h", its lowercase η is "n"), then everything is lowercased and
// mapped again, so a Cyrillic capital І or О cannot hide "ignore" (review t3r4 BLOCK 1).
const CAPITAL_LOOKALIKES: Record<string, string> = {
  "А": "a", "В": "b", "Г": "r", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c",
  "Т": "t", "Х": "x", "У": "y", "І": "i", "Ї": "i", "Ј": "j", "Ѕ": "s", "Ԁ": "d", "Ԛ": "q",
  "Ԝ": "w", "Ӏ": "l", "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k",
  "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
};
const LOOKALIKES: Record<string, string> = {
  "а": "a", "в": "b", "г": "r", "ԁ": "d", "е": "e", "ё": "e", "һ": "h", "і": "i", "ї": "i", "ј": "j",
  "к": "k", "ӏ": "l", "м": "m", "ո": "n", "о": "o", "р": "p", "ԛ": "q", "с": "c", "ѕ": "s",
  "т": "t", "у": "y", "х": "x", "ԝ": "w", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i",
  "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ɑ": "a", "ɡ": "g",
};
// Imperatives on their stems (ignores, ignoring, forgetting, overridden …) and the words that
// address the reader. Matched on two spellings of the text: punctuation as a space, and
// punctuation removed, so "i.gnore" and "for-get" are caught as well as "rice,ignore".
const DIRECTIVE = /(?:^| )(?:ignor[\p{L}\p{N}]*|forg[eo]t[\p{L}\p{N}]*|disregard[\p{L}\p{N}]*|overrid[\p{L}\p{N}]*|overrode|pretend[\p{L}\p{N}]*|instruct[\p{L}\p{N}]*|system[\p{L}\p{N}]*|assistant[\p{L}\p{N}]*|prompt[\p{L}\p{N}]*|you|your|yours|yourself|act as)(?= |$)/u;

function directiveText(value: string): string {
  return [...value.normalize("NFKC")]
    .map((char) => CAPITAL_LOOKALIKES[char] ?? char.toLowerCase())
    .map((char) => LOOKALIKES[char] ?? char).join("")
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function isDirective(value: string): boolean {
  const text = directiveText(value);
  const spaced = text.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const joined = text.replace(/[^\p{L}\p{N}\s]+/gu, "").replace(/\s+/g, " ").trim();
  return DIRECTIVE.test(spaced) || DIRECTIVE.test(joined);
}

const fold = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/\s+/g, " ").trim();
const clean = (raw: string) => raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

function plainFood(value: string): boolean {
  return value.length > 0 && value.length <= FOOD_VALUE_MAX && FOOD_CHARS.test(value)
    && !URL_LIKE.test(value) && !isDirective(value);
}

/** The names a food value may ground to: the account's own first, then the common-foods list. */
export type FoodGrounding = { exact: Map<string, string>; base: Map<string, string> };

export function foodGrounding(accountNames: readonly string[] = []): FoodGrounding {
  const exact = new Map<string, string>();
  const base = new Map<string, string>();
  for (const raw of [...accountNames, ...FOOD_DB.map((food) => food.name)]) {
    if (typeof raw !== "string") continue;
    const name = clean(raw);
    if (!plainFood(name)) continue;
    const key = fold(name);
    if (!exact.has(key)) exact.set(key, name);
    const family = baseFoodName(name);
    // The plain family name ("Milk") is the family's best spelling; otherwise the first seen.
    if (family && (!base.has(family) || key === family)) base.set(family, name);
  }
  return { exact, base };
}

/** The canonical name `raw` grounds to, or null. Exact name first, then the same base family. */
function groundFood(raw: string, grounding: FoodGrounding): string | null {
  const value = clean(raw);
  if (!plainFood(value)) return null;
  return grounding.exact.get(fold(value)) ?? grounding.base.get(baseFoodName(value)) ?? null;
}

const PORTION = /^(?:0\.(?:25|5|75)|[1-4](?:\.5)?) (?:cups?|tbsp|tsp|pieces?|slices?)$/;

// Exhaustive over MemoryKind: a kind added without its own validator does not compile.
const VALIDATORS: Record<MemoryKind, (raw: string, grounding: FoodGrounding) => string | null> = {
  liked_food: groundFood,
  disliked_food: groundFood,
  usual_meal_time: (raw) => {
    const value = clean(raw);
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
  },
  portion_preference: (raw) => {
    const value = clean(raw).toLowerCase();
    return PORTION.test(value) ? value : null;
  },
  cuisine_preference: (raw) => {
    const value = clean(raw).toLowerCase();
    return CUISINES.has(value) ? value : null;
  },
  goal_context: (raw) => {
    const value = clean(raw).toLowerCase();
    return GOALS.has(value) ? value : null;
  },
};

function item(kind: unknown, raw: unknown, grounding: FoodGrounding): MemoryItem | null {
  if (typeof kind !== "string" || typeof raw !== "string") return null;
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) return null;
  const value = VALIDATORS[kind as MemoryKind](raw, grounding);
  return value === null ? null : { kind: kind as MemoryKind, value };
}

/** One `kind|value` entry, from the wire or from a stored row. */
export function parseMemoryEntry(entry: unknown, grounding: FoodGrounding): MemoryItem | null {
  if (typeof entry !== "string" || entry.length > MEMORY_WIRE_ENTRY_MAX) return null;
  const split = entry.indexOf("|");
  if (split < 0 || entry.indexOf("|", split + 1) >= 0) return null;
  return item(entry.slice(0, split), entry.slice(split + 1), grounding);
}

const entryOf = (memory: MemoryItem) => `${memory.kind}|${memory.value}`;
const sameFood = (a: MemoryItem, b: MemoryItem) =>
  FOOD_KINDS.has(a.kind) && FOOD_KINDS.has(b.kind) && fold(a.value) === fold(b.value);
const sameItem = (a: MemoryItem, b: MemoryItem) =>
  (a.kind === b.kind && fold(a.value) === fold(b.value)) || sameFood(a, b);

/** Stored order is oldest first. A newer item replaces its twin (and the opposite food mark). */
export function mergeMemory(
  stored: readonly MemoryItem[], incoming: readonly MemoryItem[],
): MemoryItem[] {
  let merged = [...stored];
  for (const next of incoming) merged = [...merged.filter((old) => !sameItem(old, next)), next];
  while (merged.length > MEMORY_MAX_ITEMS
    || (merged.length > 0 && encodeMemory(merged).length > MEMORY_MAX_CHARS)) {
    merged = merged.slice(1);
  }
  return merged;
}

export function encodeMemory(items: readonly MemoryItem[]): string {
  return STORED_PREFIX + JSON.stringify(items.map(entryOf));
}

/**
 * A stored row, re-validated item by item. `dirty` says the row holds something that is not a
 * valid item now (legacy prose, a malformed or ungrounded entry), so the turn should rewrite it.
 */
export function readStoredMemory(
  summary: string | null | undefined, grounding: FoodGrounding,
): { items: MemoryItem[]; dirty: boolean } {
  if (!summary || summary.trim().length === 0) return { items: [], dirty: false };
  if (!summary.startsWith(STORED_PREFIX) || summary.length > MEMORY_MAX_CHARS) {
    return { items: [], dirty: true };
  }
  let raw: unknown;
  try { raw = JSON.parse(summary.slice(STORED_PREFIX.length)); } catch {
    return { items: [], dirty: true };
  }
  if (!Array.isArray(raw)) return { items: [], dirty: true };
  const items: MemoryItem[] = [];
  let dirty = raw.length > MEMORY_MAX_ITEMS;
  // Newest first, so a twin (including liked/disliked of one food) keeps its NEWEST form.
  for (const entry of raw.slice(-MEMORY_MAX_ITEMS).reverse()) {
    const parsed = parseMemoryEntry(entry, grounding);
    if (!parsed || items.some((newer) => sameItem(newer, parsed))) { dirty = true; continue; }
    // A canonical spelling that moved is a rewrite too, so the row converges on the account's name.
    if (entry !== entryOf(parsed)) dirty = true;
    items.unshift(parsed);
  }
  return { items, dirty };
}

/**
 * The prompt form: one `kind|value` line per valid item, in the exact shape the model emits.
 * Ungrounded or malformed items are dropped one by one; the rest still render.
 */
export function renderStoredMemory(
  summary: string | null | undefined, accountFoodNames: readonly string[] = [],
): string | null {
  const { items } = readStoredMemory(summary, foodGrounding(accountFoodNames));
  // Only as many as the model can echo on the wire; the server keeps the older ones regardless.
  const shown = items.slice(-MEMORY_WIRE_MAX_ITEMS);
  return shown.length > 0 ? shown.map(entryOf).join("\n") : null;
}

/**
 * What the turn writes to `coach_threads.summary`, or null to leave the row as it is.
 *
 * `complete` is false when the account's food names could not all be read this turn (no day
 * context, or a truncated list): then a stored food item cannot be told apart from a poisoned one,
 * so nothing is merged or rewritten. An empty list is written as `M1:[]`, which clears a
 * poisoned row (the save path skips a null summary).
 */
export function nextMemory(input: {
  stored: string | null | undefined; emitted: readonly string[] | undefined;
  accountFoodNames: readonly string[]; complete: boolean;
}): string | null {
  if (!input.complete) return null;
  const grounding = foodGrounding(input.accountFoodNames);
  const stored = readStoredMemory(input.stored, grounding);
  const incoming: MemoryItem[] = [];
  for (const entry of input.emitted ?? []) {
    const parsed = parseMemoryEntry(entry, grounding);
    if (parsed) incoming.push(parsed);
  }
  if (incoming.length === 0 && !stored.dirty) return null;
  return encodeMemory(mergeMemory(stored.items, incoming));
}

/** The account's food names from the day context, and whether they are the whole list. */
export function accountFoodNames(lists: {
  eats: readonly string[]; avoid: readonly string[]; eatsMore: number; avoidMore: number;
  allNames?: readonly string[]; allNamesComplete?: boolean;
} | null | undefined): { names: readonly string[]; complete: boolean } {
  if (!lists) return { names: [], complete: false };
  if (lists.allNames) return { names: lists.allNames, complete: lists.allNamesComplete === true };
  return { names: [...lists.eats, ...lists.avoid],
    complete: lists.eatsMore === 0 && lists.avoidMore === 0 };
}
