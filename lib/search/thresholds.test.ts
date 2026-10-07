import { describe, expect, it } from "vitest";
import { AUTO_RESOLVE, shouldAutoResolve } from "./thresholds";

const cls = "generic" as const;

describe("AUTO_RESOLVE", () => {
  it("carries a branded and a generic pair, both inside [0,1]", () => {
    for (const key of ["branded", "generic"] as const) {
      expect(AUTO_RESOLVE[key].minScore).toBeGreaterThan(0);
      expect(AUTO_RESOLVE[key].minScore).toBeLessThanOrEqual(1);
      expect(AUTO_RESOLVE[key].minMargin).toBeGreaterThanOrEqual(0);
      expect(AUTO_RESOLVE[key].minMargin).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldAutoResolve", () => {
  const { minScore, minMargin } = AUTO_RESOLVE[cls];

  it("never auto-resolves a single hit", () => {
    expect(shouldAutoResolve([{ score: 0.99 }], cls)).toBe(false);
  });

  it("never auto-resolves an empty result", () => {
    expect(shouldAutoResolve([], cls)).toBe(false);
  });

  it("needs the score as well as the margin", () => {
    expect(shouldAutoResolve([{ score: minScore - 0.01 }, { score: 0 }], cls)).toBe(false);
  });

  it("needs the margin as well as the score", () => {
    expect(
      shouldAutoResolve([{ score: minScore }, { score: minScore - (minMargin - 0.01) }], cls)
    ).toBe(false);
  });

  it("auto-resolves when both clear", () => {
    expect(shouldAutoResolve([{ score: minScore }, { score: minScore - minMargin }], cls)).toBe(true);
  });

  it("reads the threshold of the class it is given", () => {
    const top = { score: 1 };
    const second = { score: 1 - AUTO_RESOLVE.branded.minMargin };
    expect(shouldAutoResolve([top, second], "branded")).toBe(true);
  });
});
