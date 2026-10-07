import { beforeEach, describe, expect, it } from "vitest";
import { checkAttemptLimit, resetAttemptLimits } from "./attempt-limit";

describe("checkAttemptLimit", () => {
  beforeEach(() => {
    resetAttemptLimits();
  });

  it("allows the first several attempts for one key", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(checkAttemptLimit("otp:sasha@example.com")).toBeNull();
    }
  });

  it("locks out a key once it passes the limit within the window", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(checkAttemptLimit("otp:sasha@example.com")).toBeNull();
    }
    const message = checkAttemptLimit("otp:sasha@example.com");
    expect(message).not.toBeNull();
    expect(message).toMatch(/too many attempts/i);
  });

  it("keeps different keys independent, so one email cannot lock out another", () => {
    for (let i = 0; i < 6; i += 1) checkAttemptLimit("otp:sasha@example.com");
    expect(checkAttemptLimit("otp:other@example.com")).toBeNull();
  });

  it("keeps the password and otp namespaces independent for the same email", () => {
    for (let i = 0; i < 6; i += 1) checkAttemptLimit("otp:sasha@example.com");
    expect(checkAttemptLimit("password:sasha@example.com")).toBeNull();
  });
});
