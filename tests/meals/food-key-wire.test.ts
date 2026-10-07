/**
 * Phase 18 W3 / D13: the optional `foodKey` on generated components is wire-stable. Stored
 * snapshots and older clients without it still parse; a key survives the phone's own schema; an
 * unknown key is "no key", never an error; the strict consumed-recipe snapshot is untouched.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Food } from "@/lib/foods";
import { componentFoodKey, parseFoodKey } from "@/lib/meals/food-key";
import { sizePlate } from "@/lib/meals/size";
import { consumedRecipeSnapshotSchema, itemOverridesSchema, planDayFields, planDayProjectionSchema }
  from "@/lib/sync/plan-days-schema";

const food = (id: string, extra: Partial<Food> = {}): Food => ({ id, name: "Chicken breast", role: "protein",
  unit: "oz", perUnit: { protein: 8, carbs: 0, fat: 1 }, status: "eats", updatedAt: "2026-10-01", ...extra });
const component = { name: "Chicken breast", qty: 4, unit: "oz", role: "protein",
  macros: { kcal: 160, protein: 32, carbs: 0, fat: 4 } } as const;

describe("foodKey on generated components", () => {
  it("keys an account food by its own id even when it was made from a catalog food (Sol W3 r1)", () => {
    const own = "0b9c2f7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    expect(componentFoodKey(food(own, { catalogFoodId: 901 }))).toBe(`food:${own}`);
    expect(componentFoodKey(food("catalog:77"))).toBe("catalog:77");
    expect(componentFoodKey(food("banana"))).toBe("food:banana");
    expect(componentFoodKey(food("", { catalogFoodId: 5 }))).toBe("catalog:5");
    expect(componentFoodKey(food(""))).toBeUndefined();
    expect(componentFoodKey(food("Not An Id!"))).toBeUndefined();
  });

  it("is carried by every line a generated plate sizes", () => {
    const rows = sizePlate([{ food: food("own-1", { catalogFoodId: 901 }), part: "anchor" }],
      { kcal: 300, protein: 30, carbs: 0, fat: 5 });
    expect(rows?.every((row) => row.component.foodKey === "food:own-1")).toBe(true);
  });

  it("parses only the shapes this version knows", () => {
    expect(parseFoodKey("catalog:901")).toEqual({ kind: "catalog", catalogFoodId: 901 });
    expect(parseFoodKey("food:own-1")).toEqual({ kind: "food", id: "own-1" });
    for (const bad of [undefined, null, 7, "", "catalog:-1", "catalog:abc", "catalog:0", "food:", "food:Own Food",
      "food:../x", "u:banana", "x".repeat(200)]) {
      expect(parseFoodKey(bad)).toBeNull();
    }
  });
});

describe("plan_days wire stability (D13)", () => {
  it("a stored override without foodKey still parses and projects", () => {
    const parsed = planDayProjectionSchema.parse({ item_overrides: { "meal-2": { baseMealId: "gen",
      components: [component] } } });
    expect(planDayFields(parsed).itemOverrides?.["meal-2"]?.components[0]).toEqual(component);
  });

  it("this client keeps a component's foodKey through its own schema", () => {
    const parsed = itemOverridesSchema.parse({ "meal-2": { baseMealId: "gen",
      components: [{ ...component, foodKey: "catalog:901" }] } });
    expect(parsed["meal-2"]?.components[0].foodKey).toBe("catalog:901");
  });

  it("an older client's schema (the pre-W3 component, not strict) drops the key and keeps the row", () => {
    const amount = z.number().finite().nonnegative();
    const preW3 = z.object({ name: z.string().min(1), qty: amount,
      unit: z.enum(["oz", "cup", "tbsp", "tsp", "whole", "pouch", "can", "g", "ml"]),
      role: z.enum(["protein", "carb", "fat", "free"]),
      macros: z.object({ kcal: amount, protein: amount, carbs: amount, fat: amount }) });
    expect(preW3.parse({ ...component, foodKey: "catalog:901" })).toEqual(component);
  });

  it("keeps a malformed key as the foodKeyInvalid marker (never silently dropped) and still accepts the day", () => {
    for (const foodKey of ["", 7, "catalog:abc", "food:Not An Id", "x".repeat(200)]) {
      const parsed = itemOverridesSchema.parse({ "meal-2": { baseMealId: null, components: [{ ...component, foodKey }] } });
      const line = parsed["meal-2"]!.components[0];
      expect(line).toEqual({ ...component, foodKeyInvalid: true });
    }
  });

  it("keeps the marker through a second pass (a phone re-saving the line), and never pairs it with a key", () => {
    const once = itemOverridesSchema.parse({ "meal-2": { baseMealId: null, components: [{ ...component, foodKey: "catalog:abc" }] } });
    const twice = itemOverridesSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice["meal-2"]!.components[0]).toEqual({ ...component, foodKeyInvalid: true });
    const both = itemOverridesSchema.parse({ "meal-2": { baseMealId: null,
      components: [{ ...component, foodKey: "catalog:901", foodKeyInvalid: true }] } });
    expect(both["meal-2"]!.components[0]).toEqual({ ...component, foodKeyInvalid: true });
  });

  it("leaves the strict consumed-recipe snapshot unchanged", () => {
    expect(consumedRecipeSnapshotSchema.safeParse({ baseMealId: "recipe:abcdefgh", title: "Bowl",
      components: [{ name: "Bowl", qty: 1, unit: "whole", role: "free",
        macros: { kcal: 1, protein: 0, carbs: 0, fat: 0 }, foodKey: "catalog:1" }] }).success).toBe(false);
  });
});
