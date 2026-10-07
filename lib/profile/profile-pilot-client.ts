/**
 * May onboarding show the cuisine question? (Phase 18 W5, D2; the W15 ablation decides.) One
 * boolean from `GET /api/onboarding/profile-pilot`: `true` only for a 200 whose body says
 * `enabled: true`. Anything else — an error, a timeout, another status, another shape, a route not
 * deployed yet — is `false`, so nobody sees the question before the server assigns them a pilot arm
 * (a stray exposure would spoil W15's comparison). The arm itself is the server's; this reads it only.
 */
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";

export const PROFILE_PILOT_PATH = "/api/onboarding/profile-pilot";

export async function readProfilePilot(
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<boolean> {
  try {
    const h = opts.account ?? accountHandle();
    const response = await accountFetch(h, PROFILE_PILOT_PATH,
      { cache: "no-store", credentials: "same-origin" }, { budget: "prefs", fetchImpl: opts.fetchImpl });
    if (response.status !== 200) return false;
    const body = await accountJson<unknown>(h, response);
    return typeof body === "object" && body !== null && (body as { enabled?: unknown }).enabled === true;
  } catch (e) {
    rethrowAccountChanged(e);
    return false;
  }
}
