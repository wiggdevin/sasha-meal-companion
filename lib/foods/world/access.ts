/**
 * Who may open the food world yet (Phase 18 D14, W2b). Server-side switches, all off by default,
 * so no account opens before the owner decides:
 *
 * - `OPEN_WORLD_ENABLED=1` releases the open world at all. It stays unset until the universe and
 *   cuisine-tier review is recorded (owner decision Q3) and the safety gates pass.
 * - `OPEN_WORLD_USER_IDS` (comma-separated account ids) stages the release: while it lists anyone,
 *   the flag opens the world ONLY for the listed accounts (the opt-in route, the onboarding open
 *   default and the invitation alike). Empty or unset: the flag alone decides, as before. `*` lists
 *   every account. The allowlist pattern of `RECIPE_PLANNING_USER_IDS`.
 * - `OPEN_WORLD_HOLD_USER_IDS` (comma-separated account ids) holds named accounts closed even then,
 *   with no invitation, whatever the release list says: so no personal identifier enters the code
 *   (Q5).
 *
 * Closing is always allowed: `food_world` is the stop switch.
 */
export type OpenWorldEnv = { OPEN_WORLD_ENABLED?: string; OPEN_WORLD_HOLD_USER_IDS?: string;
  OPEN_WORLD_USER_IDS?: string };

function ids(value: string | undefined): string[] {
  return (value ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0);
}

export function openWorldReleased(env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return env.OPEN_WORLD_ENABLED === "1";
}

/** The staged-release list: true when it is empty or unset, holds `*`, or names this account. */
export function openWorldListed(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  const listed = ids(env.OPEN_WORLD_USER_IDS);
  return listed.length === 0 || listed.includes("*") || listed.includes(userId);
}

export function openWorldHeld(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return ids(env.OPEN_WORLD_HOLD_USER_IDS).includes(userId);
}

/** Whether this account may open now: released, on the release list (when one is set), not held. */
export function openWorldOpenableFor(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return openWorldReleased(env) && openWorldListed(userId, env) && !openWorldHeld(userId, env);
}
