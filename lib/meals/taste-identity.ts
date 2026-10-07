/**
 * What one eaten food IS for the taste profile (Phase 18 D5, slice W3).
 *
 * An eaten food maps to one universe item when it can (the bundled food id, the SR Legacy code of
 * its catalog food, or its exact name), else to its normalized name family (the
 * `set_food_membership` family, lib/foods/base-name.ts). A family match counts at half weight.
 *
 * Generated components carry an optional `foodKey` (lib/meals/food-key.ts) so a tick matches
 * exactly; older ticks have none and match by name.
 *
 * Pure. No I/O.
 */

import { dbFood } from "@/lib/food-db";
import { baseFoodName } from "@/lib/foods/base-name";
import { UNIVERSE, universeEntry } from "@/lib/foods/universe/manifest";

export { componentFoodKey, FOOD_KEY_MAX, parseFoodKey, type ParsedFoodKey } from "@/lib/meals/food-key";

export type TasteMatch = "universe" | "family";

/** `key` is `u:<universe id>` or `f:<family name>`; `name` is what the profile shows. */
export type TasteIdentity = { key: string; name: string; match: TasteMatch };

/** Lower case, accents folded, spaces collapsed: "exact name" ignores only those. */
export function exactName(name: string): string {
  return (name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\s+/g, " ").trim();
}

const BY_FDC = new Map<number, string>();
const BY_NAME = new Map<string, string>();
for (const entry of [...UNIVERSE].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  if (!BY_FDC.has(entry.fdcId)) BY_FDC.set(entry.fdcId, entry.id);
  const row = dbFood(entry.id);
  for (const name of [row?.name, row?.sr]) {
    const key = name ? exactName(name) : "";
    if (key && !BY_NAME.has(key)) BY_NAME.set(key, entry.id);
  }
}

function universeIdentity(id: string): TasteIdentity | null {
  if (!universeEntry(id)) return null;
  const row = dbFood(id);
  return row ? { key: `u:${id}`, name: row.name, match: "universe" } : null;
}

/** The universe item a bundled food id names, or null. */
export function universeById(id: string | null | undefined): TasteIdentity | null {
  return id ? universeIdentity(id) : null;
}

/** The universe item whose SR Legacy FoodData Central id this is, or null. */
export function universeBySrCode(fdcId: number | null | undefined): TasteIdentity | null {
  const id = typeof fdcId === "number" ? BY_FDC.get(fdcId) : undefined;
  return id ? universeIdentity(id) : null;
}

/** The universe item with exactly this name (its bundled name or SR description), or null. */
export function universeByName(name: string | null | undefined): TasteIdentity | null {
  const id = name ? BY_NAME.get(exactName(name)) : undefined;
  return id ? universeIdentity(id) : null;
}

/** The normalized name family; null for a name with no family (empty after normalizing). */
export function familyIdentity(name: string | null | undefined): TasteIdentity | null {
  const family = baseFoodName(name ?? "");
  return family ? { key: `f:${family}`, name: (name ?? "").trim(), match: "family" } : null;
}

/** What the server knows about one eaten food; each field is optional evidence. */
export type FoodFacts = {
  /** A bundled food id (a recipe line's `foodDbId`, a `food:` key that names one). */
  foodDbId?: string | null;
  /** The SR Legacy code, when the food's catalog source is `fdc_sr_legacy`. */
  srCode?: number | null;
  name?: string | null;
};

/** Universe by id, then SR code, then exact name; else the name family; else null. */
export function identityOf(facts: FoodFacts): TasteIdentity | null {
  return universeById(facts.foodDbId) ?? universeBySrCode(facts.srCode)
    ?? universeByName(facts.name) ?? familyIdentity(facts.name);
}

/** The universe entry's `countable` flag; family identities always count. */
export function countableIdentity(identity: TasteIdentity): boolean {
  if (identity.match !== "universe") return true;
  return universeEntry(identity.key.slice(2))?.countable !== false;
}
