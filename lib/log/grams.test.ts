import { describe, expect, it } from "vitest";
import { gramsForPortion, gramsFromUnit, isLogUnit, LOG_UNITS } from "./grams";

describe("gramsForPortion", () => {
  it("multiplies the portion's gram weight by the quantity, to a tenth", () => {
    expect(gramsForPortion({ gramWeight: 85 }, 2)).toBe(170);
    expect(gramsForPortion({ gramWeight: 158 }, 0.5)).toBe(79);
    expect(gramsForPortion({ gramWeight: 28.35 }, 1.5)).toBe(42.5);
  });

  it("returns zero for a zero quantity and refuses a negative one", () => {
    expect(gramsForPortion({ gramWeight: 85 }, 0)).toBe(0);
    expect(() => gramsForPortion({ gramWeight: 85 }, -1)).toThrow(/qty/);
  });

  it("refuses a portion with no positive gram weight", () => {
    expect(() => gramsForPortion({ gramWeight: 0 }, 1)).toThrow(/gramWeight/);
  });
});

describe("gramsFromUnit", () => {
  it("passes grams through", () => {
    expect(gramsFromUnit(140, "g")).toBe(140);
  });

  it("converts ounces at 28.349523125 g", () => {
    expect(gramsFromUnit(1, "oz")).toBe(28.3);
    expect(gramsFromUnit(6, "oz")).toBe(170.1);
  });

  it("returns null for a unit that needs a portion", () => {
    expect(gramsFromUnit(1, "portion")).toBeNull();
    expect(gramsFromUnit(2, "each")).toBeNull();
  });

  it("refuses a negative quantity", () => {
    expect(() => gramsFromUnit(-1, "g")).toThrow(/qty/);
  });
});

describe("LOG_UNITS", () => {
  it("is the four units Phase 2 writes, per the spec's open question 4", () => {
    expect(LOG_UNITS).toEqual(["g", "oz", "portion", "each"]);
    expect(isLogUnit("cup")).toBe(false);
    expect(isLogUnit("oz")).toBe(true);
  });
});
