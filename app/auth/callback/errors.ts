/**
 * The `?error=` codes app/auth/callback/route.ts sends the browser back to /sign-in with, and the
 * line the sign-in page shows for each. One table, so the route and the page cannot drift apart.
 * No server or browser imports: both sides read it.
 */

export const CALLBACK_ERRORS = {
  /** The link carried no code (a mangled or truncated link). */
  missing_code: "That link didn't work. Try again, or use the code from the email.",
  /** exchangeCodeForSession refused it: a reused or expired link, or iOS Safari vs. the installed app. */
  exchange_failed: "That link didn't work. Try again, or use the code from the email.",
  /** The callback's IP limiter stopped it (the link tapped many times; 20 a minute). */
  rate_limited: "Too many tries. Wait a minute, then try again.",
  /** Anything else: the limiter store or Supabase could not be reached. */
  service_unavailable: "Could not reach the sign-in service. Check your connection and try again.",
} as const;

export type CallbackError = keyof typeof CALLBACK_ERRORS;

/** The line for a `?error=` value, or "" for none or an unknown value. */
export function callbackErrorText(code: string | null): string {
  if (code === null || !Object.hasOwn(CALLBACK_ERRORS, code)) return "";
  return CALLBACK_ERRORS[code as CallbackError];
}
