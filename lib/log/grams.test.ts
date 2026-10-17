import { describe, expect, it } from "vitest";
import { gramsForPortion, gramsFromUnit, isLogUnit, LOG_UNITS, parseGramsText, roundGrams } from "./grams";

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

describe("parseGramsText", () => {
  it.each([["150", 150], ["150,5", 150.5], ["150.5", 150.5], ["150.", 150], [".5", 0.5], [" 80 ", 80],
    ["0", 0]])("reads %s as %s", (text, grams) => expect(parseGramsText(text)).toBe(grams));
  it.each([[""], ["-"], ["."], [","], ["-5"], ["12a"], ["1,2,3"], ["1.2.3"], ["1e3"]])(
    "reads %s as no number", (text) => expect(parseGramsText(text)).toBeNull());
});

describe("roundGrams (W058, audit N1)", () => {
  it("rounds to a tenth and never takes a positive amount to zero", () => {
    expect(roundGrams(42.46)).toBe(42.5);
    expect(roundGrams(0.04)).toBe(0.1);
    expect(roundGrams(0)).toBe(0);
    expect(gramsForPortion({ gramWeight: 0.3 }, 0.1)).toBe(0.1);
    expect(gramsFromUnit(0.01, "g")).toBe(0.1);
  });
});
