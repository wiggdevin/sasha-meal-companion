/**
 * A meal-role save as a field delta (audit 2026-10-10 P15): a `user_food_prefs` update whose
 * payload is exactly `{ role }`, the shape the server's role-only branch writes alone (migration
 * 20261210090100). Its key is the op's `entity_id`, so it carries no `food_ref_id`; it must never
 * grow a status, note or no_cook, because this device's mirror of them may be stale.
 */
import type { SyncOp } from "./types";

const ROLES: ReadonlySet<unknown> = new Set(["protein", "carb", "fat"]);

export function isRoleDelta(op: Pick<SyncOp, "entity" | "kind" | "payload">): boolean {
  if (op.entity !== "user_food_prefs" || op.kind !== "update") return false;
  const keys = Object.keys(op.payload ?? {});
  return keys.length === 1 && keys[0] === "role" && ROLES.has(op.payload.role);
}

/** The server row already carries a stored role: the delta has nothing left to do. */
export function hasStoredRole(row: Record<string, unknown>): boolean {
  return ROLES.has(row.role);
}
