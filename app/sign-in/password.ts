/**
 * The password path on the sign-in screen. The email link stays the default;
 * the password exists so the account can sign in without the email round
 * trip and its 2-emails-per-hour mailer limit. Sessions have no time-box or
 * inactivity timeout on this project, so either path stays signed in.
 */

import { checkAttemptLimit } from "@/app/sign-in/attempt-limit";

export type PasswordAuth = {
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: { message: string } | null }>;
};

const EMPTY = "Enter your email and password.";
const MISMATCH = "That email and password did not match.";
const OFFLINE = "Could not reach the sign-in service. Check your connection and try again.";

/** Returns an error message for the screen, or null when the session is set. */
export async function signInWithPassword(
  auth: PasswordAuth,
  email: string,
  password: string,
): Promise<string | null> {
  const address = email.trim();
  if (address.length === 0 || password.trim().length === 0) return EMPTY;
  const throttled = checkAttemptLimit(`password:${address.toLowerCase()}`);
  if (throttled) return throttled;
  try {
    const { error } = await auth.signInWithPassword({ email: address, password });
    return error ? MISMATCH : null;
  } catch {
    return OFFLINE;
  }
}
