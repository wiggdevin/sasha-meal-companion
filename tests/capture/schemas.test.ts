import { describe, expect, it } from "vitest";
import { assertSupported } from "@/lib/ai/json-schema";
import { CAPTURE_SCHEMAS, labelNutrientsSchema, textItemsSchema } from "@/lib/ai/schemas";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";

const ITEM = { label: "Egg, whole", grams: 100, qty: 2, unit: "whole", confidence: 0.82 };

describe("CAPTURE_SCHEMAS", () => {
  it("converts every capture schema to the Gemini subset", () => {
    for (const [purpose, schema] of Object.entries(CAPTURE_SCHEMAS)) {
      expect(() => assertSupported(schema), purpose).not.toThrow();
    }
  });

  it("names one schema per capture purpose", () => {
    expect(Object.keys(CAPTURE_SCHEMAS))
      .toEqual(["textToItems", "voiceToItems", "labelToNutrients", "photoToItems"]);
  });
});

describe("textItemsSchema", () => {
  it("parses a well-formed item list", () => {
    const parsed = textItemsSchema.parse({ items: [ITEM], notes: [] });
    expect(parsed.items[0].grams).toBe(100);
  });

  it("rejects a confidence outside 0..1", () => {
    expect(textItemsSchema.safeParse({ items: [{ ...ITEM, confidence: 1.4 }], notes: [] }).success)
      .toBe(false);
  });

  it("rejects an item with no grams, which is the plausible-but-wrong shape", () => {
    const noGrams = Object.fromEntries(Object.entries(ITEM).filter(([k]) => k !== "grams"));
    expect(textItemsSchema.safeParse({ items: [noGrams], notes: [] }).success).toBe(false);
  });

  // Lane bench 2026-09-23, case k3: "150 g grilled chicken breast" came back as qty 150 unit g and
  // failed a flat qty cap of 100 on every run, so the user got 422 schema_invalid.
  it("accepts a stated weight above 100 in grams or ounces", () => {
    const chicken = { label: "Grilled chicken breast", grams: 150, qty: 150, unit: "g",
      confidence: 0.9 };
    expect(textItemsSchema.safeParse({ items: [chicken], notes: [] }).success).toBe(true);
    const steak = { ...chicken, label: "Steak", grams: 340, qty: 12, unit: "oz" };
    expect(textItemsSchema.safeParse({ items: [steak], notes: [] }).success).toBe(true);
    expect(textItemsSchema.safeParse({ items: [{ ...chicken, qty: 5000, grams: 5000 }], notes: [] })
      .success).toBe(true);
  });

  it("keeps the 100 cap for counts and volumes, and the 5000 g cap for mass", () => {
    const tooMany = { ...ITEM, qty: 150, unit: "piece" };
    expect(textItemsSchema.safeParse({ items: [tooMany], notes: [] }).success).toBe(false);
    const cups = { ...ITEM, qty: 101, unit: "cup" };
    expect(textItemsSchema.safeParse({ items: [cups], notes: [] }).success).toBe(false);
    const heavy = { ...ITEM, qty: 5001, unit: "g", grams: 5000 };
    expect(textItemsSchema.safeParse({ items: [heavy], notes: [] }).success).toBe(false);
    const ounces = { ...ITEM, qty: 177, unit: "oz", grams: 5000 };
    expect(textItemsSchema.safeParse({ items: [ounces], notes: [] }).success).toBe(false);
    const unitCase = { ...ITEM, qty: 150, unit: "G", grams: 150 };
    expect(textItemsSchema.safeParse({ items: [unitCase], notes: [] }).success).toBe(true);
  });

  it("accepts an optional brand and refuses an unknown key", () => {
    expect(textItemsSchema.safeParse({ items: [{ ...ITEM, brand: "Kirkland" }], notes: [] }).success)
      .toBe(true);
    const loose = textItemsSchema.safeParse({ items: [{ ...ITEM, calories: 90 }], notes: [] });
    expect(loose.success && "calories" in loose.data.items[0]).toBe(false);
  });
});

describe("labelNutrientsSchema", () => {
  it("requires every canonical nutrient code and allows each to be null", () => {
    const per100g = Object.fromEntries(NUTRIENT_CODES.map((c) => [c, null]));
    const parsed = labelNutrientsSchema.parse({
      labelReadable: true, name: "Pear pouch", servingGrams: 90, per100g, ingredientsText: "pear",
    });
    expect(Object.keys(parsed.per100g)).toHaveLength(NUTRIENT_CODES.length);
    const short = { ...per100g };
    delete (short as Record<string, unknown>).protein;
    expect(labelNutrientsSchema.safeParse({ name: "x", servingGrams: 1, per100g: short }).success)
      .toBe(false);
  });
});
