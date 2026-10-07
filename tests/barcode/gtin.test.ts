import { describe, expect, it } from "vitest";
import { gtinCheckDigit, isGtin, normalizeGtin, providerCode } from "@/lib/barcode/gtin";
import { mod10CheckDigit } from "@/lib/search/gtin";

describe("normalizeGtin", () => {
  it.each([
    ["EAN-8", "96385074", "00000096385074"],
    ["UPC-A", "036000291452", "00036000291452"],
    ["EAN-13", "4006381333931", "04006381333931"],
    ["GTIN-14", "10036000291459", "10036000291459"],
  ])("pads a valid %s to 14 digits", (_label, raw, expected) => {
    expect(normalizeGtin(raw)).toBe(expected);
  });

  it("keeps leading zeros that are part of the code", () => {
    expect(normalizeGtin("0036000291452")).toBe("00036000291452");
  });

  it("returns null for a bad check digit", () => {
    expect(normalizeGtin("4006381333932")).toBeNull();
  });

  it("returns null for a length that is not a GTIN", () => {
    expect(normalizeGtin("12345")).toBeNull();
    expect(normalizeGtin("123456789012345")).toBeNull();
  });

  it("returns null for all zeros", () => {
    expect(normalizeGtin("00000000")).toBeNull();
  });
});

describe("gtinCheckDigit", () => {
  it("computes the mod-10 digit over 13 digits", () => {
    expect(gtinCheckDigit("0400638133393")).toBe(1);
    expect(gtinCheckDigit("0003600029145")).toBe(2);
  });

  it("refuses a body that is not 13 digits", () => {
    expect(() => gtinCheckDigit("123")).toThrow(RangeError);
    expect(() => gtinCheckDigit("040063813339x")).toThrow(RangeError);
  });

  it("delegates to the shared mod10CheckDigit helper instead of re-implementing the loop", () => {
    expect(gtinCheckDigit("0400638133393")).toBe(mod10CheckDigit("0400638133393"));
    expect(gtinCheckDigit("0003600029145")).toBe(mod10CheckDigit("0003600029145"));
  });
});

describe("isGtin", () => {
  it("is true exactly when normalizeGtin returns a value", () => {
    expect(isGtin("4006381333931")).toBe(true);
    expect(isGtin("4006381333932")).toBe(false);
    expect(isGtin("hello")).toBe(false);
  });
});

describe("providerCode", () => {
  it("drops the GTIN-14 padding down to the EAN-13 form providers store", () => {
    expect(providerCode("04006381333931")).toBe("4006381333931");
    expect(providerCode("00036000291452")).toBe("0036000291452");
    expect(providerCode("00000096385074")).toBe("0000096385074");
  });

  it("leaves a true ITF-14 alone", () => {
    expect(providerCode("10036000291459")).toBe("10036000291459");
  });
});
