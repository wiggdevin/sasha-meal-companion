/**
 * Phase 18 D2 / W15: whether this account sees the optional onboarding cuisine question.
 *
 * Closed for everyone until W15 assigns stable, randomized pilot and control arms before first
 * exposure: showing the question to anyone earlier would leave them outside a clean comparison, and
 * §5 tests one onboarding answer at a time. W15 replaces the body with the arm lookup; the route and
 * the phone's one-boolean read stay as they are. Country is set in Settings or by
 * the one pre-selected, editable onboarding chip (docs/decisions/2026-10-08-us-default-country.md;
 * D2: no required country screen, never inferred).
 */
export function profilePilotEnabled(_userId: string): boolean {
  return false;
}
