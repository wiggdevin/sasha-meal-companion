/**
 * The typed-code verification path called from app/sign-in/page.tsx. Also
 * calls Supabase directly from the browser (see attempt-limit.ts), so it gets
 * the same email-keyed throttle in front of it as the password path in
 * app/sign-in/password.ts.
 */

import { checkAttemptLimit } from "@/app/sign-in/attempt-limit";

export type OtpAuth = {
  verifyOtp(params: {
    email: string;
    token: string;
    type: "email";
  }): Promise<{ error: { message: string } | null }>;
};

const MISMATCH = "That code did not work. Check it and try again.";

/** Returns an error message for the screen, or null once the session is set. */
export async function verifyOtpCode(auth: OtpAuth, email: string, code: string): Promise<string | null> {
  const address = email.trim();
  const throttled = checkAttemptLimit(`otp:${address.toLowerCase()}`);
  if (throttled) return throttled;
  const { error } = await auth.verifyOtp({ email: address, token: code, type: "email" });
  return error ? MISMATCH : null;
}
