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

/** The codes the screen tells apart: the IP limiter, Supabase's own limit, and no connection. */
export const LIMITED_CODES: ReadonlySet<string> = new Set(["rate_limited", "auth_rate_limited"]);

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
