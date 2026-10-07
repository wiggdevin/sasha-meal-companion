import { describe, expect, it } from "vitest";
import { uuidV5 } from "./uuid5";
import { dbFood } from "@/lib/food-db";
import { STARTERS, starterFood, starterPortionGrams } from "./starter";
import { accountUnitGrams } from "./unit-grams";
import { gramsPerUnit, perUnitTo100g } from "@/lib/units";
import { repairableLegacyStarterNutrition, verifiedStarterForUserFood } from "./starter-attestation";

const owner = "11111111-1111-4111-8111-111111111111";
const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** A row as the per_100g writer stored it: before the one resolver (`legacy`) or after it. */
async function seededRow(id: string, writer: "legacy" | "current" = "legacy") {
  const food = starterFood(id, "eats");
  // The legacy writer, spelled out as it was: food list first (every ml 1 g), then the starter.
  const legacy = food.unit === "ml" ? 1 : gramsPerUnit(food.name, food.unit) ?? starterPortionGrams(food.name, food.unit);
  const grams = writer === "current" ? accountUnitGrams(food) : legacy;
  if (grams === null) throw new Error(`Missing starter portion: ${id}`);
  return {
    id: await uuidV5(namespace, `legacy-food:${owner}:${food.id}`),
    kind: "custom", name: food.name, brand: null, ingredients_text: null,
    allergen_tags: [], catalog_food_id: null, deleted_at: null,
    per_100g: perUnitTo100g(food.perUnit, grams),
  };
}

describe("starter row attestation", () => {
  it("recognizes only an exact account-owned bundled starter row", async () => {
    const row = await seededRow("tofu-firm");
    expect((await verifiedStarterForUserFood(owner, row))?.id).toBe("tofu-firm");
    expect(await verifiedStarterForUserFood("22222222-2222-4222-8222-222222222222", row)).toBeNull();
    expect(await verifiedStarterForUserFood(owner, { ...row, name: "Unknown protein" })).toBeNull();
    expect(await verifiedStarterForUserFood(owner, { ...row, per_100g: {
      ...row.per_100g, protein: 200,
    } })).toBeNull();
    expect(await verifiedStarterForUserFood(owner, { ...row, ingredients_text: "may contain milk" })).toBeNull();
    expect(await verifiedStarterForUserFood(owner, { ...row, allergen_tags: ["dairy"] })).toBeNull();
    expect(await verifiedStarterForUserFood(owner, { ...row, deleted_at: "2026-09-27" })).toBeNull();
  });

  it("attests each starter using the row shape written by food membership", async () => {
    for (const item of STARTERS) {
      const row = await seededRow(item.id);
      expect((await verifiedStarterForUserFood(owner, row))?.id).toBe(item.id);
    }
  });

  it("attests rows the current writer stores (starter weight first) for every starter", async () => {
    for (const item of STARTERS) {
      const row = await seededRow(item.id, "current");
      expect((await verifiedStarterForUserFood(owner, row))?.id).toBe(item.id);
    }
  });

  it("stores a banana's true per-100 g now: the curated 118 g, not the food list's 81 g", async () => {
    const legacy = await seededRow("banana", "legacy");
    const current = await seededRow("banana", "current");
    // The curated 118 g gives back the food list's own per-100 g carbs exactly (to the stored 0.1 g).
    const listCarbs = Math.round(dbFood("banana")!.per100g.carbs * 10) / 10;
    expect(current.per_100g.carbohydrate).toBe(listCarbs);
    expect(legacy.per_100g.carbohydrate).not.toBe(current.per_100g.carbohydrate);
    // A row still holding another starter's numbers is not attested by either order.
    expect(await verifiedStarterForUserFood(owner, { ...current,
      per_100g: (await seededRow("tofu-firm", "current")).per_100g })).toBeNull();
  });

  it("repairs only the old deterministic whey row with empty nutrition", async () => {
    const row = { ...await seededRow("whey-protein-powder"), per_100g: {} };
    const macros = await repairableLegacyStarterNutrition(owner, row);
    expect(macros?.energy_kcal).toBeGreaterThan(0);
    expect(macros?.protein).toBeGreaterThan(0);
    expect(await repairableLegacyStarterNutrition("22222222-2222-4222-8222-222222222222", row))
      .toBeNull();
    expect(await repairableLegacyStarterNutrition(owner, { ...row, brand: "Other" })).toBeNull();
    expect(await repairableLegacyStarterNutrition(owner, { ...row, per_100g: { protein: 1 } }))
      .toBeNull();
    expect(await repairableLegacyStarterNutrition(owner, {
      ...await seededRow("tofu-firm"), per_100g: {},
    })).toBeNull();
  });
});

describe("legacyWriterUnitGrams", () => {
  it("counts a millilitre as 1 g, as the old writer did, and never answers 0 or NaN", async () => {
    const { legacyWriterUnitGrams } = await import("./unit-grams");
    expect(legacyWriterUnitGrams({ name: "Grandma's tonic", unit: "ml" })).toBe(1);
    expect(legacyWriterUnitGrams({ name: "Olive oil", unit: "ml" })).toBe(1);
    expect(legacyWriterUnitGrams({ name: "Banana", unit: "whole" })).toBe(81);
    expect(legacyWriterUnitGrams({ name: "Grandma's stew", unit: "cup" })).toBeNull();
  });
});
