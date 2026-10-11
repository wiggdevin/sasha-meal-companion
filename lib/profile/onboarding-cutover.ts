/**
 * The onboarding cutover (2026-09-19): accounts first opened at or before it are grandfathered
 * (invited, never forced), later ones are brand new. Pure, no imports, so the server can read the
 * same rule `accountDisposition` (lib/profile/onboarding-state.ts) uses on the phone.
 */
export const ONBOARDING_CUTOVER = "2026-09-19T18:20:00Z";

/**
 * True only for a brand-new account: a readable `first_opened_at` after the cutover. A missing or
 * unreadable value is not brand new (the same conservative reading as `accountDisposition`).
 */
export function openedAfterCutover(firstOpenedAt: unknown): boolean {
  if (typeof firstOpenedAt !== "string") return false;
  const openedAt = Date.parse(firstOpenedAt);
  return Number.isFinite(openedAt) && openedAt > Date.parse(ONBOARDING_CUTOVER);
}
