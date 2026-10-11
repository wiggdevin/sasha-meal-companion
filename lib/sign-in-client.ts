"use client";

/**
 * The sign-in screen's calls to the app's own sign-in routes (W052, lib/server/sign-in.ts), which
 * pass an IP-keyed limiter before they reach Supabase Auth. The answer sets the session cookies, so
 * the screen then leaves with a full document load, as before.
 *
 * Every call answers `{ error: null }` or `{ error: { code } }`, never throws: a dropped connection
 * or a deadline is `offline`.
 */

import { fetchWithDeadline } from "@/lib/fetch-with-deadline";

export type SignInError = { code: string };
export type SignInResult = { error: SignInError | null };

/** The codes that mean "wait": the app's IP limiter and Supabase's own limit. */
export const LIMITED_CODES: ReadonlySet<string> = new Set(["rate_limited", "auth_rate_limited"]);

/**
 * The codes that mean nothing judged the email, code or password: no connection, the limiter's
 * store down (503), Supabase Auth down (502), or an answer that is not the app's (Sol review, W052).
 * The screen says the service could not be reached, never "did not match".
 */
export const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "offline", "failed", "rate_limit_unavailable", "auth_unavailable", "internal",
]);

async function post(path: string, body: unknown): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetchWithDeadline("signIn", path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { error: { code: "offline" } };
  }
  if (res.ok) return { error: null };
  const answer = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { error: { code: typeof answer?.error === "string" ? answer.error : "failed" } };
}

/** The adapter the sign-in screen, the code form and the password form share. */
export function signInAuth() {
  return {
    signInWithOtp: (args: { email: string; create: boolean; next: string }): Promise<SignInResult> =>
      post("/api/auth/otp", args),
    verifyOtp: (args: { email: string; token: string; type: "email" }): Promise<SignInResult> =>
      post("/api/auth/verify", { email: args.email, code: args.token }),
    signInWithPassword: (args: { email: string; password: string }): Promise<SignInResult> =>
      post("/api/auth/password", args),
  };
}
