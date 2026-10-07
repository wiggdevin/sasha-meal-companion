import { describe, expect, it } from "vitest";
import { toGtin14 } from "./gtin";

describe("toGtin14", () => {
  it("pads an EAN-13 to fourteen digits", () => {
    expect(toGtin14("4006381333931")).toBe("04006381333931");
  });

  it("pads a UPC-A to fourteen digits", () => {
    expect(toGtin14("036000291452")).toBe("00036000291452");
  });

  it("pads an EAN-8 to fourteen digits", () => {
    expect(toGtin14("96385074")).toBe("00000096385074");
  });

  it("passes an already-14 code through", () => {
    expect(toGtin14("00036000291452")).toBe("00036000291452");
  });

  it("ignores spaces and hyphens", () => {
    expect(toGtin14(" 0-36000 29145 2 ")).toBe("00036000291452");
  });

  it("returns null on a bad check digit", () => {
    expect(toGtin14("036000291453")).toBeNull();
    expect(toGtin14("4006381333930")).toBeNull();
  });

  it("returns null on a length no GTIN uses", () => {
    expect(toGtin14("12345")).toBeNull();
    expect(toGtin14("123456789012345")).toBeNull();
    expect(toGtin14("")).toBeNull();
  });

  it("returns null for an all-zero code", () => {
    expect(toGtin14("00000000")).toBeNull();
  });
});
