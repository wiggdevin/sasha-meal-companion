import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { entryFingerprint, fingerprintSource, type FingerprintInput } from "./fingerprint";

const base: FingerprintInput = {
  localDate: "2026-09-11", slot: "meal-1", eatenAt: "2026-09-11T12:03:00.000Z",
  items: [{ canonicalFoodId: "cat:1042", grams: 120 }, { canonicalFoodId: "cat:2011", grams: 30 }],
};
const withGrams = (grams: number) => ({ ...base, items: [{ canonicalFoodId: "cat:1042", grams }] });

describe("fingerprintSource", () => {
  it("is the architecture §3.7 pre-image", () => {
    expect(fingerprintSource(base)).toBe("2026-09-11|meal-1|1987920|cat:1042:120,cat:2011:30");
  });
  it("does not depend on the order the devices listed the items", () => {
    expect(fingerprintSource({ ...base, items: [...base.items].reverse() })).toBe(fingerprintSource(base));
  });
  it("collapses gram jitter inside one 5 g bucket", () => {
    expect(fingerprintSource(withGrams(101))).toBe(fingerprintSource(withGrams(102)));
  });
  it("collapses 102 g and 104 g into the same 5 g bucket (contracts §4.1: floor, not round)", () => {
    expect(fingerprintSource(withGrams(102))).toBe(fingerprintSource(withGrams(104)));
  });
  it("keeps two entries inside the same 15-minute bucket together", () => {
    expect(fingerprintSource({ ...base, eatenAt: "2026-09-11T12:14:59.000Z" })).toBe(fingerprintSource(base));
  });
  it("separates two coffees 20 minutes apart", () => {
    const coffee = { ...base, slot: "coffee", items: [{ canonicalFoodId: "cat:14209", grams: 240 }] };
    expect(fingerprintSource({ ...coffee, eatenAt: "2026-09-11T12:23:00.000Z" }))
      .not.toBe(fingerprintSource(coffee));
  });
});

describe("entryFingerprint", () => {
  it("is the sha256 of the pre-image, lowercase hex", async () => {
    const expected = createHash("sha256").update(fingerprintSource(base), "utf8").digest("hex");
    await expect(entryFingerprint(base)).resolves.toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });
  it("gives two devices the same fingerprint for the same event", async () => {
    const phone = await entryFingerprint(base);
    const laptop = await entryFingerprint({
      ...base, eatenAt: "2026-09-11T12:07:41.000Z",
      items: [{ canonicalFoodId: "cat:2011", grams: 31 }, { canonicalFoodId: "cat:1042", grams: 122 }],
    });
    expect(laptop).toBe(phone);
  });
});
