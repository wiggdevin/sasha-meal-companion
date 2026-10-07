import { beforeEach, describe, expect, it } from "vitest";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import { verifyOtpCode, type OtpAuth } from "@/app/sign-in/otp";

function auth(result: { message: string } | null): OtpAuth & { calls: unknown[] } {
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
    const a = auth({ message: "Token has expired or is invalid" });
    expect(await verifyOtpCode(a, "sasha@example.com", "000000")).toBe(
      "That code did not work. Check it and try again.",
    );
  });

  it("locks out repeated guesses for one email instead of calling Supabase forever", async () => {
    const a = auth({ message: "Token has expired or is invalid" });
    for (let i = 0; i < 5; i += 1) {
      await verifyOtpCode(a, "sasha@example.com", "000000");
    }
    const message = await verifyOtpCode(a, "sasha@example.com", "000000");
    expect(message).toMatch(/too many attempts/i);
    // The 6th guess never reached Supabase.
    expect(a.calls).toHaveLength(5);
  });

  it("keeps one email's lockout from blocking a different email", async () => {
    const a = auth({ message: "Token has expired or is invalid" });
    for (let i = 0; i < 6; i += 1) {
      await verifyOtpCode(a, "sasha@example.com", "000000");
    }
    const before = a.calls.length;
    await verifyOtpCode(a, "someone-else@example.com", "111111");
    expect(a.calls.length).toBe(before + 1);
  });
});
