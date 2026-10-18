/**
 * UI audit 2026-10-18 §9: only a code or password the server judged wrong counts toward the
 * 5-try page floor; a try that never reached it (offline, an outage, a limit) uses nothing up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import { verifyOtpCode, type OtpAuth } from "@/app/sign-in/otp";
import { signInWithPassword, type PasswordAuth } from "@/app/sign-in/password";

function otp(code: string | null): OtpAuth & { calls: number } {
  const a = { calls: 0, async verifyOtp() { a.calls += 1; return { error: code === null ? null : { code } }; } };
  return a;
}

function password(code: string | null): PasswordAuth & { calls: number } {
  const a = { calls: 0, async signInWithPassword() { a.calls += 1; return { error: code === null ? null : { code } }; } };
  return a;
}

describe("attempt floor counts judged attempts only", () => {
  beforeEach(() => resetAttemptLimits());

  it.each(["offline", "auth_unavailable", "rate_limited", "auth_rate_limited"])(
    "ten code tries answered %s never lock the email out",
    async (code) => {
      const a = otp(code);
      for (let i = 0; i < 10; i += 1) await verifyOtpCode(a, "person@example.com", "12345678");
      expect(a.calls).toBe(10);
      expect(await verifyOtpCode(otp("invalid_code"), "person@example.com", "1")).toBe(
        "That code did not work. Check it and try again.",
      );
    },
  );

  it("locks the code check after five wrong codes", async () => {
    const a = otp("invalid_code");
    for (let i = 0; i < 5; i += 1) await verifyOtpCode(a, "person@example.com", "1");
    expect(await verifyOtpCode(a, "person@example.com", "1")).toMatch(/too many attempts/i);
    expect(a.calls).toBe(5);
  });

  it.each(["offline", "failed", "rate_limited"])("ten password tries answered %s never lock out", async (code) => {
    const a = password(code);
    for (let i = 0; i < 10; i += 1) await signInWithPassword(a, "person@example.com", "pw");
    expect(a.calls).toBe(10);
  });

  it("a thrown password call is not counted", async () => {
    const a: PasswordAuth = { async signInWithPassword() { throw new TypeError("Failed to fetch"); } };
    for (let i = 0; i < 10; i += 1) await signInWithPassword(a, "person@example.com", "pw");
    expect(await signInWithPassword(password("invalid_credentials"), "person@example.com", "pw")).toBe(
      "That email and password did not match.",
    );
  });
});
