import { beforeEach, describe, expect, it } from "vitest";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import { verifyOtpCode, type OtpAuth } from "@/app/sign-in/otp";

function auth(result: { code: string } | null): OtpAuth & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async verifyOtp(params) {
      calls.push(params);
      return { error: result };
    },
  };
}

describe("verifyOtpCode", () => {
  beforeEach(() => {
    resetAttemptLimits();
  });

  it("returns null and calls Supabase with the trimmed email when the code is right", async () => {
    const a = auth(null);
    expect(await verifyOtpCode(a, " sasha@example.com ", "123456")).toBeNull();
    expect(a.calls).toEqual([{ email: "sasha@example.com", token: "123456", type: "email" }]);
  });

  it("returns a plain message when Supabase rejects the code", async () => {
    const a = auth({ code: "invalid_code" });
    expect(await verifyOtpCode(a, "sasha@example.com", "000000")).toBe(
      "That code did not work. Check it and try again.",
    );
  });

  it("locks out repeated guesses for one email instead of calling Supabase forever", async () => {
    const a = auth({ code: "invalid_code" });
    for (let i = 0; i < 5; i += 1) {
      await verifyOtpCode(a, "sasha@example.com", "000000");
    }
    const message = await verifyOtpCode(a, "sasha@example.com", "000000");
    expect(message).toMatch(/too many attempts/i);
    // The 6th guess never reached Supabase.
    expect(a.calls).toHaveLength(5);
  });

  it("keeps one email's lockout from blocking a different email", async () => {
    const a = auth({ code: "invalid_code" });
    for (let i = 0; i < 6; i += 1) {
      await verifyOtpCode(a, "sasha@example.com", "000000");
    }
    const before = a.calls.length;
    await verifyOtpCode(a, "someone-else@example.com", "111111");
    expect(a.calls.length).toBe(before + 1);
  });

  // W052: the server's IP limiter and Supabase's own limit say to wait, not "wrong code".
  it.each(["rate_limited", "auth_rate_limited"])("tells the person to wait on %s", async (code) => {
    expect(await verifyOtpCode(auth({ code }), "sasha@example.com", "12345678")).toBe(
      "Too many tries. Wait a few minutes, then try again.",
    );
  });

  it("says the service could not be reached when the connection drops", async () => {
    expect(await verifyOtpCode(auth({ code: "offline" }), "sasha@example.com", "12345678")).toBe(
      "Could not reach the sign-in service. Check your connection and try again.",
    );
  });
});
