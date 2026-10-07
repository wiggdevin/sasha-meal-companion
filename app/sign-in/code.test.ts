import { describe, expect, it } from "vitest";
import {
  CODE_MAX_DIGITS,
  CODE_MIN_DIGITS,
  CODE_PATTERN,
  isValidCode,
  normalizeCode,
  toCodeInput,
} from "./code";

describe("normalizeCode", () => {
  it("strips spaces a phone keyboard or paste can add", () => {
    expect(normalizeCode("123 456")).toBe("123456");
    expect(normalizeCode(" 123456 ")).toBe("123456");
    expect(normalizeCode("1 2 3 4 5 6")).toBe("123456");
  });

  it("leaves a clean code unchanged", () => {
    expect(normalizeCode("123456")).toBe("123456");
  });
});

describe("isValidCode", () => {
  it("accepts exactly six digits", () => {
    expect(isValidCode("123456")).toBe(true);
    expect(isValidCode("000000")).toBe(true);
  });

  it("accepts 6 to 8 digits — Supabase mailer_otp_length is 8 on this project", () => {
    expect(isValidCode("1234567")).toBe(true);
    expect(isValidCode("12345678")).toBe(true);
  });

  it("rejects anything outside 6–8 clean digits", () => {
    expect(isValidCode("12345")).toBe(false);
    expect(isValidCode("123456789")).toBe(false);
    expect(isValidCode("12345a")).toBe(false);
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("123 456")).toBe(false);
  });
});

describe("code length bounds", () => {
  it("accepts the 8 digits this project's mailer actually sends", () => {
    // The bug this guards: the field capped typing at 6 and its HTML pattern
    // demanded exactly 6, while mailer_otp_length is 8. A real code could not
    // be entered in full, so the email fallback could never succeed.
    expect(CODE_MAX_DIGITS).toBe(8);
    expect(CODE_PATTERN).toBe(`[0-9]{${CODE_MIN_DIGITS},${CODE_MAX_DIGITS}}`);
    expect(isValidCode("1".repeat(CODE_MAX_DIGITS))).toBe(true);
    expect(isValidCode("1".repeat(CODE_MIN_DIGITS))).toBe(true);
    expect(isValidCode("1".repeat(CODE_MAX_DIGITS + 1))).toBe(false);
    expect(isValidCode("1".repeat(CODE_MIN_DIGITS - 1))).toBe(false);
  });
});

describe("toCodeInput", () => {
  it("keeps a pasted code with separators, so every digit survives", () => {
    expect(toCodeInput("1234 5678")).toBe("12345678");
    expect(toCodeInput(" 1234\n5678 ")).toBe("12345678");
    expect(isValidCode(toCodeInput("1234 5678"))).toBe(true);
  });

  it("clamps at the longest allowed code rather than truncating mid-paste", () => {
    expect(toCodeInput("1234567890")).toBe("12345678");
    expect(toCodeInput("123456")).toBe("123456");
  });

  it("never holds a value its own validator would reject for shape", () => {
    // The field's value is always digits only, so submit never fails on
    // whitespace the user cannot see.
    for (const raw of ["1234 5678", "12 34 56 78", "\t12345678\n"]) {
      expect(toCodeInput(raw)).toMatch(/^[0-9]*$/);
    }
  });
});
