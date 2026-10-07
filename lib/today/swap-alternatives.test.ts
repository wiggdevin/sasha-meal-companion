import { describe, expect, it } from "vitest";
import { swapAlternatives } from "./swap-alternatives";
import type { Food } from "@/lib/foods";
import type { RecipeRow } from "@/lib/recipes-client";

const target = { kcal: 685, protein: 45, carbs: 70, fat: 20 };
const make = (id: string, role: Food["role"], perUnit: Food["perUnit"]): Food => ({
  id, name: id, role, perUnit, unit: "oz", status: "eats", updatedAt: "2026-09-26",
});
const proteins = ["chicken", "turkey", "salmon", "tofu", "beans", "eggs"];
const foods = Object.fromEntries([
  ...proteins.map((id) => [id, make(id, "protein", { protein: 10, carbs: 0, fat: 1 })]),
  ["rice", make("rice", "carb", { protein: 0, carbs: 10, fat: 0 })],
  ["oil", make("oil", "fat", { protein: 0, carbs: 0, fat: 5 })],
]) as Record<string, Food>;
const refs = Object.fromEntries(Object.keys(foods).map((id) =>
  [id, { userRefId: `ref-${id}`, syncedAt: "2026-09-26", status: "eats" as const, note: null }]));

describe("account-owned swap alternatives", () => {
  it("offers at least five different proteins within ten percent of the target", () => {
    const options = swapAlternatives({ slot: "meal-4", target, foods });
    expect(options.length).toBeGreaterThanOrEqual(5);
    expect(new Set(options.slice(0, 5).map((row) => row.proteinKey)).size).toBe(5);
    for (const row of options) {
      expect(Math.abs(row.macros.kcal - target.kcal)).toBeLessThanOrEqual(target.kcal * 0.1);
      expect(row.components.length).toBeGreaterThan(0);
    }
  });

  it("offers no new plate when a snapshot was required and none is usable (Phase 17 O2, D2)", () => {
    expect(swapAlternatives({ slot: "meal-4", target, foods })).not.toEqual([]);
    expect(swapAlternatives({ slot: "meal-4", target, foods, evidence: null })).toEqual([]);
  });

  it("includes a recipe and saved meal only when all ingredient refs belong to Eats", () => {
    const recipe = { id: "one", name: "My recipe", servings: 1,
      items: [{ food_ref_id: "ref-chicken", grams: 127.57 },
        { food_ref_id: "ref-rice", grams: 198.45 },
        { food_ref_id: "ref-oil", grams: 113.4 }],
      nutrients_per_serving: {}, yield_grams: null, rev: 1 } as RecipeRow;
    const savedMeals = [{ id: "two", name: "My saved meal", items: recipe.items },
      { id: "unsafe", name: "Unknown ingredient", items: [
        { food_ref_id: "another-account-ref", grams: 100 }] }];
    const options = swapAlternatives({ slot: "meal-2", target, foods, refs,
      recipes: [recipe], savedMeals });
    expect(options.map((row) => row.name)).toContain("My recipe");
    expect(options.map((row) => row.name)).toContain("My saved meal");
    expect(options.map((row) => row.name)).not.toContain("Unknown ingredient");
  });

  it("leaves out a saved meal whose ingredient is a liquid of unknown density (no invented mass)", () => {
    const tonic: Food = { id: "tonic", name: "Grandma's tonic", role: "carb", unit: "ml",
      perUnit: { protein: 0, carbs: 0.1, fat: 0 }, status: "eats", updatedAt: "2026-09-26" };
    const withTonic = { ...foods, tonic };
    const tonicRefs = { ...refs, tonic: { userRefId: "ref-tonic", syncedAt: "2026-09-26", status: "eats" as const, note: null } };
    const items = [{ food_ref_id: "ref-chicken", grams: 127.57 }, { food_ref_id: "ref-rice", grams: 198.45 },
      { food_ref_id: "ref-oil", grams: 113.4 }];
    const options = swapAlternatives({ slot: "meal-2", target, foods: withTonic, refs: tonicRefs, savedMeals: [
      { id: "ok", name: "Known weights", items },
      { id: "tonic", name: "With tonic", items: [...items, { food_ref_id: "ref-tonic", grams: 250 }] }] });
    expect(options.map((row) => row.name)).toContain("Known weights");
    expect(options.map((row) => row.name)).not.toContain("With tonic");
  });

  it("never borrows foods marked Avoid or options from a missing target", () => {
    const unsafe = { ...foods, chicken: { ...foods.chicken, status: "avoid" as const } };
    const options = swapAlternatives({ slot: "meal-1", target, foods: unsafe });
    expect(options.some((row) => row.proteinKey === "chicken")).toBe(false);
    expect(swapAlternatives({ slot: "meal-1", target: { ...target, kcal: 0 }, foods }))
      .toEqual([]);
  });

  it("shows a visually identical meal only once when Eats contains duplicate food rows", () => {
    const duplicate = { ...foods, "tofu-copy": { ...foods.tofu, id: "tofu-copy" } };
    const options = swapAlternatives({ slot: "meal-1", target, foods: duplicate });
    const visible = options.map((row) => [row.name,
      ...(["kcal", "protein", "carbs", "fat"] as const)
        .map((key) => Math.round(row.macros[key]))].join("|"));
    expect(options.length).toBeGreaterThanOrEqual(5);
    expect(new Set(visible).size).toBe(options.length);
  });
});
