/** `NODE_ENV` is named only so `process.env` fits; this gate never reads it (no development fallback). */
type AccessEnv = { REBALANCE_PANEL_USER_IDS?: string; NODE_ENV?: string; SUPABASE_URL?: string };

/**
 * Phase 19 §6.2: the rebalance panel is off unless an account UUID, or an explicit '*', is
 * allowlisted. Unlike the recipe pilot there is no development or localhost fallback: an empty or
 * missing allowlist is off everywhere, so the panel stays hidden until the D6 clinical sign-off is
 * recorded in docs/decisions/ and the env is set.
 */
export function rebalanceAccessEnabled(userId: string, env: AccessEnv = process.env): boolean {
  const selected = (env.REBALANCE_PANEL_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return selected.includes("*") || selected.includes(userId);
}
