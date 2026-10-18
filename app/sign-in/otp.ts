/**
 * The typed-code verification path called from app/sign-in/page.tsx. The call goes through the
 * app's IP-limited route (lib/sign-in-client.ts, W052); the email-keyed throttle in
 * attempt-limit.ts stays in front of it as a page-memory floor.
 */

import { checkAttemptLimit, recordFailedAttempt } from "@/app/sign-in/attempt-limit";
import { LIMITED_CODES, UNAVAILABLE_CODES, type SignInError } from "@/lib/sign-in-client";

export type OtpAuth = {
  verifyOtp(params: {
    email: string;
    token: string;
    type: "email";
  }): Promise<{ error: SignInError | null }>;
};

const MISMATCH = "That code did not work. Check it and try again.";
const LIMITED = "Too many tries. Wait a few minutes, then try again.";
const OFFLINE = "Could not reach the sign-in service. Check your connection and try again.";

/** Returns an error message for the screen, or null once the session is set. */
export async function verifyOtpCode(auth: OtpAuth, email: string, code: string): Promise<string | null> {
  const address = email.trim();
  const limitKey = `otp:${address.toLowerCase()}`;
  const throttled = checkAttemptLimit(limitKey);
  if (throttled) return throttled;
  const { error } = await auth.verifyOtp({ email: address, token: code, type: "email" });
  if (!error) return null;
  if (LIMITED_CODES.has(error.code)) return LIMITED;
  if (UNAVAILABLE_CODES.has(error.code)) return OFFLINE;
  // Only a code the server judged counts toward the floor; offline or limited tries do not.
  recordFailedAttempt(limitKey);
  return MISMATCH;
}
