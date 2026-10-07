/** Entity-key encoding — contracts §4, architecture §3.7. The ONLY place that knows the four key
 *  shapes of the synced tables. Lane A's SQL must produce identical strings. */
import type { Entity } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_KEYED = new Set<Entity>(["user_foods", "log_entries", "gut_log", "duplicate_groups",
  "recipes", "favorites_meals", "target_profiles", "target_proposals", "food_membership"]);
const DATE_KEYED = new Set<Entity>(["plan_days", "water_log"]);
/** Registry-UUID keyed: the row's tenant is (user_id, food_ref_id), and food_ref_id is unique
 *  across catalog and user foods (architecture §3.2), so it is the key on its own. */
const REF_KEYED = new Set<Entity>(["user_food_prefs", "favorites_foods"]);

function fail(entity: Entity, column: string, value: unknown): never {
  throw new TypeError(`${entity}: ${column} is not a valid entity key (got ${JSON.stringify(value)})`);
}

function uuid(entity: Entity, column: string, value: unknown): string {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (!UUID_RE.test(lower)) fail(entity, column, value);
  return lower;
}

function localDate(entity: Entity, value: unknown): string {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  if (!DATE_RE.test(text)) fail(entity, "local_date", value);
  return text;
}

export function encodeKey(entity: Entity, row: Record<string, unknown>): string {
  if (ID_KEYED.has(entity)) return uuid(entity, "id", row.id);
  if (DATE_KEYED.has(entity)) return localDate(entity, row.local_date);
  if (entity === "user_settings") return "settings";
  if (REF_KEYED.has(entity)) return uuid(entity, "food_ref_id", row.food_ref_id);
  if (entity === "favorites_recipes") return uuid(entity, "recipe_id", row.recipe_id);
  throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
}

export function decodeKey(entity: Entity, key: string): Record<string, unknown> {
  if (ID_KEYED.has(entity)) return { id: uuid(entity, "id", key) };
  if (DATE_KEYED.has(entity)) return { local_date: localDate(entity, key) };
  if (entity === "user_settings") {
    if (key !== "settings") fail(entity, "entity_key", key);
    return {}; // the PK is user_id, which the client never supplies (contracts §8)
  }
  if (REF_KEYED.has(entity)) return { food_ref_id: uuid(entity, "food_ref_id", key) };
  if (entity === "favorites_recipes") return { recipe_id: uuid(entity, "recipe_id", key) };
  throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
}
