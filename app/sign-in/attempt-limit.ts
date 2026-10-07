/**
 * Email-keyed throttle for the two sign-in paths that call Supabase directly
 * from the browser — `verifyOtp` (app/sign-in/otp.ts) and
 * `signInWithPassword` (app/sign-in/password.ts). Neither ever reaches an app
 * server route, so neither can be keyed by IP the way
 * `app/auth/callback/route.ts` keys `enforceRateLimit` (lib/server/ratelimit.ts)
 * — email is the only stable identifier available before Supabase confirms
 * who is signing in.
 *
 * This is a floor, not a substitute for server-side protection: it lives in
 * page memory, so a reload clears it. The real backstop is whatever the
 * Supabase project's own auth rate limit is configured to.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

const LIMIT = 5;
const WINDOW_SECONDS = 15 * 60;

/** Null when the attempt is allowed; otherwise a message for the screen. */
export function checkAttemptLimit(key: string): string | null {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now >= window.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return null;
  }
  window.count += 1;
  if (window.count > LIMIT) {
    const minutes = Math.max(1, Math.ceil((window.resetAt - now) / 60000));
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return null;
}

/** Forget every window. Tests only. */
export function resetAttemptLimits(): void {
  windows.clear();
}
