/**
 * The password path on the sign-in screen. The email link stays the default;
 * the password exists so the account can sign in without the email round
 * trip and its 2-emails-per-hour mailer limit. Sessions have no time-box or
 * inactivity timeout on this project, so either path stays signed in.
 * The call goes through the app's IP-limited route (lib/sign-in-client.ts, W052).
 */

import { checkAttemptLimit, recordFailedAttempt } from "@/app/sign-in/attempt-limit";
import { LIMITED_CODES, UNAVAILABLE_CODES, type SignInError } from "@/lib/sign-in-client";

export type PasswordAuth = {
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: SignInError | null }>;
};

const EMPTY = "Enter your email and password.";
const MISMATCH = "That email and password did not match.";
const OFFLINE = "Could not reach the sign-in service. Check your connection and try again.";
const LIMITED = "Too many tries. Wait a few minutes, then try again.";

/** Returns an error message for the screen, or null when the session is set. */
export async function signInWithPassword(
  auth: PasswordAuth,
  email: string,
  password: string,
): Promise<string | null> {
  const address = email.trim();
  if (address.length === 0 || password.trim().length === 0) return EMPTY;
  const limitKey = `password:${address.toLowerCase()}`;
  const throttled = checkAttemptLimit(limitKey);
  if (throttled) return throttled;
  try {
    const { error } = await auth.signInWithPassword({ email: address, password });
    if (!error) return null;
    if (LIMITED_CODES.has(error.code)) return LIMITED;
    if (UNAVAILABLE_CODES.has(error.code)) return OFFLINE;
    // Only a password the server judged counts toward the floor; offline or limited tries do not.
    recordFailedAttempt(limitKey);
    return MISMATCH;
  } catch {
    return OFFLINE;
  }
}
