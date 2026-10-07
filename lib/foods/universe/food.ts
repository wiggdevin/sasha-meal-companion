/**
 * A universe item as a plate food (Phase 18 D1, D11): the bundled row's per-gram macros, unit "g",
 * the role the shared rule infers. One function, so the server's admission (lib/foods/universe/
 * derive.ts) and the phone's open-world pool (lib/meals/open-world.ts) build the same food from the
 * same bundled row: phone and server agree by construction.
 *
 * The bundle is a nutrition source only, never an admission source: a caller decides WHICH ids may
 * become plate foods (the snapshot's `admittedUniverseIds`).
 *
 * Pure. No I/O.
 */

import type { DbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { inferFoodRole } from "@/lib/foods/role";

/** The plate-pool id of a universe item: prefixed, so it never collides with an account food id. */
export const UNIVERSE_FOOD_PREFIX = "universe:";

export function universePoolId(id: string): string {
  return `${UNIVERSE_FOOD_PREFIX}${id}`;
}

/** The bundled id inside a pool id, or null when the id is not a universe pool id. */
export function universeIdOf(poolId: string): string | null {
  return poolId.startsWith(UNIVERSE_FOOD_PREFIX) ? poolId.slice(UNIVERSE_FOOD_PREFIX.length) || null : null;
}

/** The account-facing food for a bundled row: per-gram macros, unit "g", marked nothing. */
export function universeFood(row: DbFood): Food {
  const perUnit = { protein: row.per100g.protein / 100, carbs: row.per100g.carbs / 100,
    fat: row.per100g.fat / 100 };
  return { id: row.id, name: row.name, role: inferFoodRole(row.name, perUnit), unit: "g",
    perUnit, status: "neutral", updatedAt: "1970-01-01" };
}
