import { beforeEach, describe, expect, it } from "vitest";
import { checkAttemptLimit, recordFailedAttempt, resetAttemptLimits } from "./attempt-limit";

const KEY = "otp:person@example.com";

describe("checkAttemptLimit", () => {
  beforeEach(() => {
    resetAttemptLimits();
  });

  it("allows attempts while fewer than five were judged wrong", () => {
    for (let i = 0; i < 4; i += 1) recordFailedAttempt(KEY);
    expect(checkAttemptLimit(KEY)).toBeNull();
  });

  it("locks out a key after five wrong attempts within the window", () => {
    for (let i = 0; i < 5; i += 1) recordFailedAttempt(KEY);
    expect(checkAttemptLimit(KEY)).toMatch(/too many attempts/i);
  });

  it("never counts a check on its own, so tries that reach no server use nothing up", () => {
    for (let i = 0; i < 20; i += 1) expect(checkAttemptLimit(KEY)).toBeNull();
  });

  it("keeps different keys independent, so one email cannot lock out another", () => {
    for (let i = 0; i < 6; i += 1) recordFailedAttempt(KEY);
    expect(checkAttemptLimit("otp:other@example.com")).toBeNull();
  });

  it("keeps the password and otp namespaces independent for the same email", () => {
    for (let i = 0; i < 6; i += 1) recordFailedAttempt(KEY);
    expect(checkAttemptLimit("password:person@example.com")).toBeNull();
  });
});
