/**
 * Email-keyed page-memory floor for the code check (app/sign-in/otp.ts) and the password sign-in
 * (app/sign-in/password.ts). A reload clears it, so it is not the protection: since W052 both calls
 * go through the app's own routes, which count every call per IP on the server
 * (lib/server/sign-in.ts, 10 per 10 minutes), and Supabase's project auth limits sit behind that.
 * It stays because it answers a run of wrong guesses on this screen before any network call. Only a
 * guess the server judged wrong counts (`recordFailedAttempt`).
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

const LIMIT = 5;
const WINDOW_SECONDS = 15 * 60;

/**
 * Null when another attempt is allowed; otherwise a message for the screen. Counts nothing: only
 * `recordFailedAttempt` does, once the server has actually judged the code or password, so a try
 * that never reached it (offline, an outage, a limit) never uses up the floor.
 */
export function checkAttemptLimit(key: string): string | null {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now >= window.resetAt || window.count < LIMIT) return null;
  const minutes = Math.max(1, Math.ceil((window.resetAt - now) / 60000));
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** Counts one attempt the server judged wrong. */
export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const window = windows.get(key);
  if (!window || now >= window.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return;
  }
  window.count += 1;
}

/** Forget every window. Tests only. */
export function resetAttemptLimits(): void {
  windows.clear();
}
