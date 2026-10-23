/**
 * What Shopping's "Pick from your foods" offers (UI makeover W7, docs/plans/2026-10-19-ui-makeover.md
 * §7.1 item 4): the account's Favorites (Favored and starred foods, starred first, a starred food
 * counting even when it is not Favored) and its Often eaten foods,
 * each grouped by aisle, each with its mark under the current food rules. Pure; no I/O.
 *
 * - A food on Avoid, or a taste row that shares its name with one, is never offered.
 * - A `blocked` food shows its mark and cannot be added; `unknown` shows its mark and can.
 * - "On list" means a line of the same bought name is already on the list. Taking it off removes
 *   only a manual, unchecked line: a plan line or a bought item stays where it is.
 */
import type { Food } from "@/lib/foods";
import { sameBaseName } from "@/lib/foods/base-name";
import { aisleOf, aisleRank, type Aisle } from "@/lib/foods/aisle";
import { componentRuleMark, type EligibleView } from "@/lib/foods/rule-marks";
import { boughtName } from "@/lib/shopping/quick-add";
import type { ShoppingLine } from "@/lib/shopping/types";
import type { RuleMark } from "@/lib/types";

export type PickSource = "favorite" | "starred" | "often";
export const PICK_SOURCE_LABEL: Readonly<Record<PickSource, string>> = {
  starred: "Starred", favorite: "Favorite", often: "Eaten often",
};

export type PickItem = {
  /** Stable per name, so a row keeps its identity across reads. */
  key: string;
  /** The name a line is added under ("Eggs", not "Egg, whole, raw"). */
  name: string;
  source: PickSource;
  role: Food["role"] | null;
  aisle: Aisle;
  ruleMark: RuleMark | null;
  /** A line of this name is on the list. */
  onList: boolean;
  /** The one line taking it off would delete: manual and unchecked. Null when there is none. */
  removable: ShoppingLine | null;
};

/** A starred food as the favourites store lists it (lib/favorites.ts `FavoriteRow`, kind "food"):
 *  a catalog food or an account food that is not Favored still counts as a pick. */
export type PickStarRow = { name: string };

/** The minimal taste row this module reads (lib/foods/taste-client.ts `TasteRow`). */
export type PickTasteRow = { key: string; name: string; days180: number };

export const pickKey = (name: string) => name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
/** A line and a food match with or without a plural "s" ("Egg" is on the list as "Eggs"). */
const matchKey = (name: string) => pickKey(name).replace(/(\w{2,}[^s])s$/, "$1");

export function pickSources({ foods, starred, starredRows = [], taste, view, lines }: {
  foods: Readonly<Record<string, Food>>;
  /** Whether a food carries a star (components/MyFoods.favorites.ts `isStarred`). */
  starred: (food: Food) => boolean;
  /** Every starred food by name, Favored or not (a scanned catalog food, a neutral food). */
  starredRows?: readonly PickStarRow[];
  taste: readonly PickTasteRow[];
  view: EligibleView | undefined;
  lines: readonly ShoppingLine[];
}): { favorites: PickItem[]; often: PickItem[] } {
  const all = Object.values(foods);
  const avoided = all.filter((food) => food.status === "avoid");
  const isAvoided = (name: string) => avoided.some((food) => sameBaseName(food.name, name));
  const byName = new Map<string, ShoppingLine[]>();
  for (const line of lines) {
    // "Eggs, large" on the list is Eggs here too: its bought name and its first comma segment.
    const keys = new Set([matchKey(boughtName(line.name) || line.name), matchKey(line.name.split(",")[0] ?? "")]);
    for (const k of keys) if (k) byName.set(k, [...(byName.get(k) ?? []), line]);
  }
  const seen = new Set<string>();
  const item = (name: string, source: PickSource, role: Food["role"] | null, bundledId?: string | null): PickItem | null => {
    const bought = boughtName(name) || name.trim();
    const key = pickKey(bought);
    if (!key || seen.has(key) || isAvoided(name)) return null;
    seen.add(key);
    const listed = byName.get(matchKey(bought)) ?? [];
    return { key, name: bought, source, role,
      aisle: aisleOf({ name, bundledId: bundledId ?? null, role }),
      ruleMark: componentRuleMark({ name }, foods as Record<string, Food>, view),
      onList: listed.length > 0,
      removable: listed.find((line) => line.origin === "manual" && !line.checked) ?? null };
  };
  const eats = all.filter((food) => food.status === "eats")
    .map((food) => ({ food, star: starred(food) }))
    .sort((a, b) => Number(b.star) - Number(a.star) || b.food.updatedAt.localeCompare(a.food.updatedAt)
      || a.food.name.localeCompare(b.food.name));
  const fromEats = ({ food, star }: { food: Food; star: boolean }) => {
    const row = item(food.name, star ? "starred" : "favorite", food.role);
    return row ? [row] : [];
  };
  // Starred first: starred Favored foods, then any other starred food, then the rest of Favored
  // (built in that order, so a name listed twice keeps its first place).
  const starredEats = eats.filter((row) => row.star).flatMap(fromEats);
  const starredOther = starredRows.flatMap((star) => {
    if (!star.name.trim()) return [];
    const own = all.find((food) => food.status !== "avoid" && sameBaseName(food.name, star.name));
    const row = item(star.name, "starred", own?.role ?? null);
    return row ? [row] : [];
  });
  const favorites = [...starredEats, ...starredOther, ...eats.filter((row) => !row.star).flatMap(fromEats)];
  const often = taste.flatMap((row) => {
    const own = all.find((food) => food.status === "eats" && sameBaseName(food.name, row.name));
    const next = item(row.name, "often", own?.role ?? null);
    return next ? [next] : [];
  });
  return { favorites, often };
}

/** Items in aisle order, each aisle keeping the items' own order (lib/foods/aisle.ts). */
export function byAisle(items: readonly PickItem[]): PickItem[] {
  return items.map((row, index) => ({ row, index }))
    .sort((a, b) => aisleRank(a.row.aisle) - aisleRank(b.row.aisle) || a.index - b.index)
    .map(({ row }) => row);
}
