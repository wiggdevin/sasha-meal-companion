/**
 * The store aisle a food sits in, for lists grouped the way a shop is walked (UI makeover W0,
 * shared by Foods, Shopping and the build flow). Runs on the phone; no server change.
 *
 * Rules, in order:
 *  1. a bundled id, else an exact name, in the common-foods database takes that row's `category`;
 *  2. else a curated meal family (`mealFamily`) means protein;
 *  3. else the stored role (protein, carb, fat → protein, grains, pantry);
 *  4. else other.
 *
 * Pure apart from one lazily built name index. These exports are frozen.
 */

import { dbFood, FOOD_DB } from "@/lib/food-db";
import { mealFamily } from "@/lib/meals/parts";

export type Aisle = "produce" | "protein" | "dairy_eggs" | "grains" | "pantry" | "drinks" | "other";

/** Every aisle in the fixed order lists show them, with its header label. */
export const AISLES: readonly { id: Aisle; label: string }[] = [
  { id: "produce", label: "Produce" },
  { id: "protein", label: "Protein" },
  { id: "dairy_eggs", label: "Dairy and eggs" },
  { id: "grains", label: "Grains and bread" },
  { id: "pantry", label: "Pantry" },
  { id: "drinks", label: "Drinks" },
  { id: "other", label: "Other" },
];

const LABELS = new Map(AISLES.map((row) => [row.id, row.label]));
const ORDER = new Map(AISLES.map((row, index) => [row.id, index]));

export function aisleLabel(aisle: Aisle): string {
  return LABELS.get(aisle) ?? "Other";
}

/** An aisle's place in `AISLES`, for sorting. */
export function aisleRank(aisle: Aisle): number {
  return ORDER.get(aisle) ?? AISLES.length;
}

/** The database `category` values and the aisle each one means. */
const CATEGORY_AISLE: Readonly<Record<string, Aisle>> = {
  vegetable: "produce",
  fruit: "produce",
  protein: "protein",
  dairy: "dairy_eggs",
  "dairy-free": "dairy_eggs",
  carb: "grains",
  fat: "pantry",
  condiment: "pantry",
  sweet: "pantry",
  supplement: "pantry",
  drink: "drinks",
  meal: "other",
};

const ROLE_AISLE: Readonly<Record<string, Aisle>> = {
  protein: "protein",
  carb: "grains",
  fat: "pantry",
};

const normalName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

let byName: Map<string, string> | null = null;
function categoryByName(name: string): string | undefined {
  if (!byName) {
    byName = new Map();
    // First row wins, so a name the database repeats keeps one answer.
    for (const row of FOOD_DB) {
      const key = normalName(row.name);
      if (!byName.has(key)) byName.set(key, row.category);
    }
  }
  return byName.get(normalName(name));
}

export type AisleInput = { name: string; bundledId?: string | null; role?: string | null };

export function aisleOf({ name, bundledId, role }: AisleInput): Aisle {
  const category = (bundledId ? dbFood(bundledId)?.category : undefined) ?? categoryByName(name);
  if (category !== undefined) {
    const aisle = CATEGORY_AISLE[category];
    if (aisle) return aisle;
  }
  if (name.trim() && mealFamily(name)) return "protein";
  if (role && ROLE_AISLE[role]) return ROLE_AISLE[role];
  return "other";
}

/**
 * Items grouped by aisle in `AISLES` order, each group keeping the items' own order; empty
 * aisles are left out.
 */
export function groupByAisle<T>(items: readonly T[], aisleFor: (item: T) => Aisle):
  { aisle: Aisle; label: string; items: T[] }[] {
  const groups = new Map<Aisle, T[]>();
  for (const item of items) {
    const aisle = aisleFor(item);
    const list = groups.get(aisle);
    if (list) list.push(item);
    else groups.set(aisle, [item]);
  }
  return AISLES.flatMap(({ id, label }) => {
    const list = groups.get(id);
    return list ? [{ aisle: id, label, items: list }] : [];
  });
}
