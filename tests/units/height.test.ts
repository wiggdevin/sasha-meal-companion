import { describe, expect, it } from "vitest";
import {
  CM_MAX,
  CM_MIN,
  FEET_MAX,
  FEET_MIN,
  INCHES_MAX,
  INCHES_MIN,
  cmToFtIn,
  formatHeight,
  ftInToCm,
  isValidCm,
  isValidFtIn,
} from "@/lib/units/height";

describe("height units", () => {
  it("round-trips every supported whole centimetre within half an inch", () => {
    for (let cm = CM_MIN; cm <= CM_MAX; cm += 1) {
      const { ft, in: inches } = cmToFtIn(cm);
      expect(Math.abs(ftInToCm(ft, inches) - cm)).toBeLessThanOrEqual(1.3000000001);
    }
  });

  it("carries a rounded twelfth inch into the next foot", () => {
    expect(cmToFtIn(182.8)).toEqual({ ft: 6, in: 0 });
  });

  it("converts feet and inches to centimetres at one decimal place", () => {
    expect(ftInToCm(5, 5)).toBe(165.1);
    expect(ftInToCm(6, 0)).toBe(182.9);
  });

  it("formats either display preference from metric storage", () => {
    expect(formatHeight(165.1, "ft_in")).toBe("5 ft 5 in");
    expect(formatHeight(165.1, "cm")).toBe("165.1 cm");
    expect(formatHeight(null, "ft_in")).toBe("—");
  });

  it("exposes and enforces the authored input ranges", () => {
    expect([CM_MIN, CM_MAX, FEET_MIN, FEET_MAX, INCHES_MIN, INCHES_MAX])
      .toEqual([50, 260, 3, 8, 0, 11]);
    expect(isValidCm(50)).toBe(true);
    expect(isValidCm(260)).toBe(true);
    expect(isValidCm(49.9)).toBe(false);
    expect(isValidFtIn(3, 0)).toBe(true);
    expect(isValidFtIn(8, 11)).toBe(true);
    expect(isValidFtIn(5, 12)).toBe(false);
    expect(isValidFtIn(2, 11)).toBe(false);
  });
});
