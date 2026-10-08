/**
 * Who may open the food world yet (Phase 18 D14, W2b). Server-side switches, all off by default,
 * so no account opens before the owner decides:
 *
 * - `OPEN_WORLD_ENABLED=1` releases the open world at all. It stays unset until the universe and
 *   cuisine-tier review is recorded (owner decision Q3) and the safety gates pass.
 * - `OPEN_WORLD_USER_IDS` (comma-separated account ids, or `*`) is the release list: the flag opens
 *   the world ONLY for the listed accounts (the opt-in route, the onboarding open default, the
 *   invitation, and every server read of `food_world`, `effectiveFoodWorld` below). Empty, unset or
 *   comma-only releases NOBODY (Sol r1 BLOCK 2, the safer default): releasing to every account
 *   takes an explicit `*`. The allowlist pattern of `RECIPE_PLANNING_USER_IDS`.
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

/** The release list: true only when it holds `*` or names this account. Empty releases nobody. */
export function openWorldListed(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  const listed = ids(env.OPEN_WORLD_USER_IDS);
  return listed.includes("*") || listed.includes(userId);
}

export function openWorldHeld(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return ids(env.OPEN_WORLD_HOLD_USER_IDS).includes(userId);
}

/** Whether this account may open now: released, on the release list, not held. */
export function openWorldOpenableFor(userId: string, env: OpenWorldEnv = process.env as OpenWorldEnv): boolean {
  return openWorldReleased(env) && openWorldListed(userId, env) && !openWorldHeld(userId, env);
}

/**
 * The world every server read acts on (Sol r1 WARN 3): the stored `user_settings.food_world`, but
 * `open` only while this account may be open now. An account stored `open` that the flag, the
 * release list or the hold list no longer allows reads `closed` everywhere (snapshot, admission,
 * the world routes). Nothing is written: the stored value comes back the moment the account is
 * allowed again, and a person's own choice is never overwritten by a release setting.
 */
export function effectiveFoodWorld(stored: unknown, userId: string,
  env: OpenWorldEnv = process.env as OpenWorldEnv): "open" | "closed" {
  return stored === "open" && openWorldOpenableFor(userId, env) ? "open" : "closed";
}
