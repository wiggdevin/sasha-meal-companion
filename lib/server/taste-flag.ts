/**
 * W5b lands dark: the `{ taste }` route, the confirm/Undo routes and the coach card run only with
 * `TASTE_CHIPS_ENABLED=1` (unset in production until the UI lane ships the taste field and the
 * card). The safety gate on the other Jev paths is not behind it.
 *
 * Its own module with no imports (Phase 18 W5b-3): `GET /api/profile/taste/enabled` reads the
 * switch without importing lib/server/taste-chips.ts, so the probe cannot reach a model call.
 */
export function tasteChipsEnabled(): boolean {
  return process.env.TASTE_CHIPS_ENABLED === "1";
}
