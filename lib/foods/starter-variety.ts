/**
 * Starter foods in plate-variety order (onb3, live QA 2026-10-08: the plan preview showed only
 * meat with rice).
 *
 * The onboarding food surfaces (the falling deck, the top-pick chips, "Sprout, pick for me") work
 * in the three stored macro roles. The "carb" role holds starches, vegetables AND fruit, and the
 * curated table lists every starch first, so a capped deck, four chips per role or two picks per
 * role never reached a vegetable or a fruit: the plan could only ever be an anchor with a starch.
 * This orders a list by the part each food plays on a plate (lib/meals/parts.ts: anchor, starch,
 * vegetable, fruit, fat) and, inside a part, by curated family, so the first few of any role cover
 * every part and do not repeat a family (chicken, then salmon, not chicken then turkey).
 *
 * Order only: it never adds, drops or re-judges a food, so the safety filtering done before
 * (`starterChoices`) stands. Pure and deterministic.
 */
import { starterFood, type Starter, type StarterMark } from "@/lib/foods/starter";
import { mealFamily, partsOf, type Part } from "@/lib/meals/parts";

/** The order parts are taken in, repeated: a starch every other carb, then a vegetable before a
 *  second fruit, so six carbs are three starches, two vegetables and a fruit. */
const PART_PATTERN: readonly Part[] = ["anchor", "starch", "veg", "fat", "starch", "fruit", "veg", "protein"];

const ROLE_PART = { protein: "anchor", carb: "starch", fat: "fat" } as const;

/** The starter as a food, or null for an id outside the curated table and the bundled list. */
function asFood(item: Starter) {
  try {
    return starterFood(item.id, "eats");
  } catch {
    return null;
  }
}

/** The part a starter plays first on a plate; a food the bundled list does not know, by role. */
export function starterPart(item: Starter): Part {
  const food = asFood(item);
  return (food ? partsOf(food)[0] : undefined) ?? ROLE_PART[item.role];
}

/** Curated families that read as one choice on a first plate (salmon and tuna are both fish). */
const FAMILY_GROUP: Readonly<Record<string, string>> = {
  salmon: "fish", tuna: "fish", "white fish": "fish", "smoked salmon": "fish", tempeh: "tofu",
  rice: "grain", quinoa: "grain",
};

/** The curated family, else the food's head noun ("White rice, cooked" → "rice", "Avocado oil" →
 *  "oil"), so two rices or two oils never lead a role together. */
function familyOf(item: Starter): string {
  const name = asFood(item)?.name;
  if (!name) return item.id;
  const family = mealFamily(name)?.key;
  if (family) return FAMILY_GROUP[family] ?? family;
  const words = name.split(",")[0].trim().toLowerCase().split(/\s+/);
  const head = words[words.length - 1] ?? item.id;
  return FAMILY_GROUP[head] ?? head;
}

/** Round-robin over buckets, buckets in first-seen order, items in input order. */
function roundRobin<T>(items: readonly T[], bucketOf: (item: T) => string, order?: readonly string[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const key of order ?? []) buckets.set(key, []);
  for (const item of items) {
    const key = bucketOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item); else buckets.set(key, [item]);
  }
  const lists = [...buckets.values()].filter((list) => list.length > 0);
  const out: T[] = [];
  for (let index = 0; out.length < items.length; index += 1) {
    for (const list of lists) if (index < list.length) out.push(list[index]);
  }
  return out;
}

/** `items` reordered so each prefix covers the most plate parts and families. */
export function starterVarietyOrder(items: readonly Starter[]): Starter[] {
  const byPart = new Map<Part, Starter[]>();
  for (const item of items) {
    const part = starterPart(item);
    byPart.set(part, [...(byPart.get(part) ?? []), item]);
  }
  const queues = new Map([...byPart].map(([part, list]) => [part, roundRobin(list, familyOf)]));
  const out: Starter[] = [];
  while (out.length < items.length) {
    for (const part of PART_PATTERN) {
      const next = queues.get(part)?.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Variety order for filling a selection: foods whose plate part the person has not chosen yet (in
 * any role) come first, so "pick for me" after "rice" adds a vegetable before a second starch.
 */
export function starterFillOrder(open: readonly Starter[], choices: readonly Starter[],
  marks: Readonly<Record<string, StarterMark>>): Starter[] {
  const covered = new Set(choices.filter((item) => marks[item.id] === "eats").map(starterPart));
  const ordered = starterVarietyOrder(open);
  return [...ordered.filter((item) => !covered.has(starterPart(item))),
    ...ordered.filter((item) => covered.has(starterPart(item)))];
}
