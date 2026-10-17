/**
 * The foreground ping — T0 §5.
 *
 * An installed PWA is not remounted between breakfast and dinner, so "opened the app" is a
 * visibility change, not a page load. One pass on the way back to the foreground keeps the
 * functions the user is about to tap already up.
 *
 * `/api/warm` alone is not enough: on Vercel each route is its OWN function, so warming the warm
 * route warms only the warm route (Grok 4.6 MEDIUM 11). The five hot routes are touched too —
 * a bodiless GET, which for a POST-only route is a 405 and for a guarded one a 401, and either
 * answer means the function and its region are loaded, which is all the ping is for.
 *
 * Best effort in every direction: no session, no body, no error path, one short deadline for the
 * whole pass so a slow network cannot make the ping itself something the user waits on.
 *
 * W047 (scale step 7): one call per foreground. The hot routes are touched only on the first
 * foreground of a page load, or when they were last touched more than `ROUTES_IDLE_MS` ago (long
 * enough for an idle function to have gone cold); every other foreground sends `/api/warm` alone.
 */

import { fetchWithDeadline } from "@/lib/fetch-with-deadline";

export const WARM_URL = "/api/warm";

/** The five routes spec §5 names, in the order a capture run reaches them. */
export const WARM_ROUTES = [
  "/api/log/propose",
  "/api/foods/barcode",
  "/api/coach",
  "/api/log/commit",
  "/api/foods/search",
] as const;

/** How long the hot routes count as warm after a touch (Vercel reclaims idle functions in minutes). */
export const ROUTES_IDLE_MS = 10 * 60_000;

/** When this page last touched the hot routes; null before the first foreground. */
let routesWarmedAt: number | null = null;

/** Forget the last touch (tests, or a new session on the same page). */
export function resetWarmState(): void {
  routesWarmedAt = null;
}

async function touch(
  url: string, method: "GET" | "HEAD", opts: { fetchImpl?: typeof fetch }
): Promise<void> {
  try {
    // `sign` is the shortest budget in the table, and nothing here is worth waiting longer for.
    await fetchWithDeadline("sign", url, { method, cache: "no-store", keepalive: true },
      { fetchImpl: opts.fetchImpl });
  } catch {
    // Offline, refused, timed out, or the app is closing. None of it is worth telling them about:
    // an answer of any kind means the function was loaded, and no answer means the next tap pays
    // the cold start it would have paid anyway.
  }
}

export async function pingWarm(opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<void> {
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return;
  const now = opts.now ?? Date.now();
  const routes = routesWarmedAt === null || now - routesWarmedAt > ROUTES_IDLE_MS;
  if (routes) routesWarmedAt = now;
  await Promise.all([
    // The warm route exists to answer a GET and does nothing else.
    touch(WARM_URL, "GET", { fetchImpl: doFetch }),
    ...(routes ? WARM_ROUTES.map((url) => touch(url, "HEAD", { fetchImpl: doFetch })) : []),
  ]);
}
