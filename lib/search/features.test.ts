import { describe, expect, it } from "vitest";
import {
  brandMatchScore, combine, eatsStatusScore, ENERGY_MISMATCH_PENALTY, featuresFromRow,
  prepStateMatchScore, qualityClassScore, userPriorScore, WEIGHTS, type Features,
} from "./features";

const ZERO: Features = {
  lexical: 0, trigram: 0, brandMatch: 0, prepStateMatch: 0, userPrior: 0, qualityClass: 0, eatsStatus: 0,
};

describe("WEIGHTS", () => {
  it("sums to exactly 1.00 at four decimals", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Number(sum.toFixed(4))).toBe(1);
  });

  it("carries the contracts §2 weights", () => {
    expect(WEIGHTS).toEqual({
      lexical: 0.35, trigram: 0.2, brandMatch: 0.15,
      prepStateMatch: 0.1, userPrior: 0.1, qualityClass: 0.05, eatsStatus: 0.05,
    });
  });
});

describe("combine", () => {
  it("is 0 for an all-zero row and 1 for an all-one row", () => {
    expect(combine(ZERO)).toBe(0);
    const ones = Object.fromEntries(Object.keys(ZERO).map((k) => [k, 1])) as Features;
    expect(combine(ones)).toBeCloseTo(1, 10);
  });

  it("weights each feature as contracts §2 says", () => {
    expect(combine({ ...ZERO, lexical: 1 })).toBeCloseTo(0.35, 10);
    expect(combine({ ...ZERO, trigram: 1 })).toBeCloseTo(0.2, 10);
    expect(combine({ ...ZERO, brandMatch: 1 })).toBeCloseTo(0.15, 10);
    expect(combine({ ...ZERO, prepStateMatch: 1 })).toBeCloseTo(0.1, 10);
    expect(combine({ ...ZERO, userPrior: 1 })).toBeCloseTo(0.1, 10);
    expect(combine({ ...ZERO, qualityClass: 1 })).toBeCloseTo(0.05, 10);
    expect(combine({ ...ZERO, eatsStatus: 1 })).toBeCloseTo(0.05, 10);
  });

  it("stays inside [0,1] on out-of-range input", () => {
    const wild = Object.fromEntries(Object.keys(ZERO).map((k) => [k, 9])) as Features;
    expect(combine(wild)).toBe(1);
    const negative = Object.fromEntries(Object.keys(ZERO).map((k) => [k, -9])) as Features;
    expect(combine(negative)).toBe(0);
  });
});

describe("userPriorScore", () => {
  it("is 0 with no logs and saturates at 20", () => {
    expect(userPriorScore(0)).toBe(0);
    expect(userPriorScore(20)).toBe(1);
    expect(userPriorScore(100)).toBe(1);
  });

  it("rises with the log count", () => {
    expect(userPriorScore(1)).toBeCloseTo(Math.log(2) / Math.log(21), 10);
    expect(userPriorScore(5)).toBeGreaterThan(userPriorScore(1));
    expect(userPriorScore(5)).toBeLessThan(1);
  });
});

describe("qualityClassScore", () => {
  it("maps the four classes", () => {
    expect(qualityClassScore("analytical", [])).toBe(1);
    expect(qualityClassScore("survey", [])).toBe(0.75);
    expect(qualityClassScore("label", [])).toBe(0.5);
    expect(qualityClassScore("crowd", [])).toBe(0.25);
  });

  it("subtracts the mismatch penalty and floors at 0", () => {
    expect(ENERGY_MISMATCH_PENALTY).toBe(0.25);
    expect(qualityClassScore("survey", ["energy_mismatch"])).toBeCloseTo(0.5, 10);
    expect(qualityClassScore("crowd", ["energy_mismatch", "carb_basis_total"])).toBeCloseTo(0, 10);
    expect(qualityClassScore("crowd", ["energy_mismatch"])).toBeGreaterThanOrEqual(0);
  });
});

describe("prepStateMatchScore", () => {
  it("is 1 on a match, 0 on a conflict, 0.5 when either side is unknown", () => {
    expect(prepStateMatchScore("roasted", "roasted")).toBe(1);
    expect(prepStateMatchScore("raw", "fried")).toBe(0);
    expect(prepStateMatchScore(null, "fried")).toBe(0.5);
    expect(prepStateMatchScore("raw", null)).toBe(0.5);
    expect(prepStateMatchScore(null, null)).toBe(0.5);
    expect(prepStateMatchScore("roasted", "unknown")).toBe(0.5);
    expect(prepStateMatchScore("unknown", "roasted")).toBe(0.5);
  });
});

describe("brandMatchScore", () => {
  it("is 0 for every row when the query names no brand", () => {
    expect(brandMatchScore(null, "Kirkland", 0.9)).toBe(0);
  });

  it("is 1 on a normalised equality", () => {
    expect(brandMatchScore("kirkland", "  Kirkland ", 0.1)).toBe(1);
    expect(brandMatchScore("Café Muller", "cafe müller", 0)).toBe(1);
  });

  it("returns 0.6 once the trigram similarity clears 0.6, else 0", () => {
    expect(brandMatchScore("kirkland", "Kirklands Best", 0.72)).toBe(0.6);
    expect(brandMatchScore("kirkland", "Kirklands Best", 0.6)).toBe(0.6);
    expect(brandMatchScore("kirkland", "Kirklands Best", 0.59)).toBe(0);
    expect(brandMatchScore("kirkland", null, 0)).toBe(0);
    expect(brandMatchScore("kirkland", "other", 4)).toBe(0.6);
  });
});

describe("eatsStatusScore", () => {
  it("is 1 eats, 0 avoid, 0.5 unknown", () => {
    expect(eatsStatusScore("eats")).toBe(1);
    expect(eatsStatusScore("avoid")).toBe(0);
    expect(eatsStatusScore(null)).toBe(0.5);
  });
});

describe("featuresFromRow", () => {
  it("maps the RPC feature columns onto Features", () => {
    expect(
      featuresFromRow({
        f_lexical: 0.4, f_trigram: 0.3, f_brand: 0, f_prep: 0.5,
        f_prior: 0.1, f_quality: 1, f_eats: 0.5,
      })
    ).toEqual({
      lexical: 0.4, trigram: 0.3, brandMatch: 0, prepStateMatch: 0.5,
      userPrior: 0.1, qualityClass: 1, eatsStatus: 0.5,
    });
  });
});
