/**
 * Who may open the food world yet (Phase 18 D14, W2b). Two server-side switches, both off by
 * default, so no account opens before the owner decides:
 *
 * - `OPEN_WORLD_ENABLED=1` releases the open world at all. It stays unset until the universe and
 *   cuisine-tier review is recorded (owner decision Q3) and the safety gates pass.
 * - `OPEN_WORLD_HOLD_USER_IDS` (comma-separated account ids) holds named accounts closed even then,
 *   with no invitation: the allowlist pattern of `RECIPE_PLANNING_USER_IDS`, so no personal
 *   identifier enters the code (Q5).
 *
 * Closing is always allowed: `food_world` is the stop switch.
 */
export type OpenWorldEnv = { OPEN_WORLD_ENABLED?: string; OPEN_WORLD_HOLD_USER_IDS?: string };

export function openWorldReleased(env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return env.OPEN_WORLD_ENABLED === "1";
}

export function openWorldHeld(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return (env.OPEN_WORLD_HOLD_USER_IDS ?? "").split(",").map((id) => id.trim())
    .some((id) => id.length > 0 && id === userId);
}
