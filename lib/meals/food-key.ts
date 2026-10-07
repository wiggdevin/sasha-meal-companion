/**
 * The wire key a generated plate component carries for its food (Phase 18 D5, slice W3), so a
 * ticked meal matches its foods exactly in the taste profile (lib/meals/taste-identity.ts):
 *   `catalog:<catalog_foods.id>`   a catalog-only food
 *   `food:<uuid>`                  the account's own food (even one made from a catalog food)
 *   `food:<bundled-id>`            a bundled universe food (pool id `universe:<bundled-id>`, W8)
 * Optional on the wire: older clients drop it and stored snapshots without it still parse
 * (lib/sync/plan-days-schema.ts). An unknown or malformed key reads as "no key", never an error.
 *
 * Kept apart from the universe lookups so the phone's plate engine (lib/meals/size.ts) imports
 * nothing more than this. Pure. No I/O.
 */

import type { Food } from "@/lib/foods";

export const FOOD_KEY_MAX = 160;

/** An account food id (`user_foods.id`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bundled food id (lib/food-db.json, the universe): lower-case words joined by hyphens. */
const BUNDLED = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The wire key a generated component carries for its food (absent when none can be formed). An
 * account food keys by its own id even when it was made from a catalog food, so the history judges
 * the food that was actually eaten (W3 r1 BLOCK); only a catalog-only food keys `catalog:<id>`.
 */
export function componentFoodKey(food: Pick<Food, "id" | "catalogFoodId">): string | undefined {
  const id = typeof food.id === "string" ? food.id.trim() : "";
  // A catalog-only snapshot food is keyed `catalog:<id>` already (lib/server/meal-snapshot.ts); an
  // open-world universe item enters the plate pool as `universe:<bundled id>` (W8, the universe's
  // food.ts) and is keyed as the bundled food it is.
  const universe = /^universe:(.+)$/.exec(id);
  const key = /^catalog:\d{1,15}$/.test(id) ? id : universe ? `food:${universe[1]}` : id ? `food:${id}`
    : typeof food.catalogFoodId === "number" ? `catalog:${food.catalogFoodId}` : undefined;
  return key && parseFoodKey(key) ? key : undefined;
}

export type ParsedFoodKey = { kind: "catalog"; catalogFoodId: number } | { kind: "food"; id: string };

/** The key's meaning, or null for anything this version does not know (never thrown). */
export function parseFoodKey(key: unknown): ParsedFoodKey | null {
  if (typeof key !== "string" || key.length > FOOD_KEY_MAX) return null;
  const catalog = /^catalog:(\d{1,15})$/.exec(key);
  if (catalog) {
    const id = Number(catalog[1]);
    return Number.isSafeInteger(id) && id > 0 ? { kind: "catalog", catalogFoodId: id } : null;
  }
  const food = /^food:(.+)$/.exec(key);
  return food && (UUID.test(food[1]) || BUNDLED.test(food[1])) ? { kind: "food", id: food[1] } : null;
}

/** Whether a wire value is a key this version knows (lib/sync/plan-days-schema.ts drops the rest). */
export function isFoodKey(key: unknown): key is string {
  return parseFoodKey(key) !== null;
}
