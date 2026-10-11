/**
 * W015 (audit 2026-10-10 F09: A013, A017): a fat or cheese band applies only when the food's head
 * noun is that fat or cheese, never when the word sits anywhere in the name.
 */
import { describe, expect, it } from "vitest";
import { portionBand, sidePartOf } from "@/lib/coach/portion-bands";
import { partsOf } from "@/lib/meals/parts";
import { sizePlate, totalOf } from "@/lib/meals/size";
import type { Food } from "@/lib/foods";

const food = (name: string, role: Food["role"], perUnit: Food["perUnit"], unit: Food["unit"] = "oz"): Food =>
  ({ id: name, name, role, unit, perUnit, status: "eats", updatedAt: "2026-10-11T00:00:00.000Z" });

// Per ounce, from lib/food-db.json (SR Legacy per 100 g × 0.2835).
const tunaInOil = food("Tuna, canned in oil, light", "protein", { protein: 8.25, carbs: 0, fat: 2.3 });
const rice = food("White rice, cooked", "carb", { protein: 0.6, carbs: 6.3, fat: 0.1 });

describe("oil-packed fish keeps a protein band (A013)", () => {
  it.each(["Tuna, canned in oil, light", "Sardines, canned in oil"])("%s gets the anchor band", (name) => {
    expect(portionBand(name, "anchor")).toEqual(portionBand("Chicken breast, roasted", "anchor"));
  });

  it("sizes a tuna plate above 12 g protein", () => {
    const rows = sizePlate([{ food: tunaInOil, part: "anchor" }, { food: rice, part: "starch" }],
      { kcal: 600, protein: 45, carbs: 60, fat: 15 });
    expect(rows).not.toBeNull();
    const tuna = rows!.find((row) => row.food === tunaInOil)!;
    expect(tuna.qty).toBeGreaterThanOrEqual(3);
    expect(totalOf(rows!).protein).toBeGreaterThan(12);
  });

  it("keeps the oil band for cooking oils and fats", () => {
    for (const name of ["Olive oil", "Oil, olive", "Coconut oil", "Ghee", "Lard", "Butter", "Butter, salted"]) {
      expect(portionBand(name, "fat").max, name).toBe(15);
    }
  });

  it("does not give mayonnaise made with oil an avocado band", () => {
    expect(portionBand("Avocado oil mayo, Primal Kitchen", "fat").max).toBeLessThanOrEqual(30);
  });

  it.each(["McDONALD'S, McCHICKEN Sandwich (without mayonnaise)", "Tuna salad with mayonnaise",
    "Chicken sandwich, mayo"])("%s keeps the anchor band (a mayo mention is not mayo)", (name) => {
    expect(portionBand(name, "anchor")).toEqual(portionBand("Unnamed dish", "anchor"));
  });
});

describe("cheese bands by head noun, not substring (A017)", () => {
  it.each(["Cheddar cheese", "Cheese, cheddar", "Cream cheese", "String cheese", "Goat cheese"])(
    "%s keeps the cheese band", (name) => {
      expect(portionBand(name, "fat")).toMatchObject({ min: 15, max: 60 });
    });

  it.each([
    ["Macaroni and cheese", "starch"], ["Pizza, cheese", "anchor"], ["Burrito, bean and cheese", "anchor"],
    ["Enchilada, cheese", "anchor"], ["Omelet, cheese", "anchor"], ["Nachos with cheese", "starch"],
    ["Dumplings, potato & cheese (pierogi)", "starch"], ["Blue cheese dressing", "fat"],
  ] as const)("%s uses its role band", (name, part) => {
    expect(portionBand(name, part)).toEqual(portionBand("Unnamed dish", part));
  });

  it.each(["Macaroni and cheese", "Pizza, cheese", "Burrito, bean and cheese", "Enchilada, cheese",
    "Nachos with cheese"])("%s is not a cheese side", (name) => {
    expect(sidePartOf(name)).not.toBe("fat");
  });

  it("gives mac and cheese no cheese part", () => {
    const mac = food("Macaroni and cheese", "carb", { protein: 1.9, carbs: 6.5, fat: 1.4 });
    expect(partsOf(mac)).toEqual(["starch"]);
  });

  it("still reads a real cheese as a fat side", () => {
    expect(sidePartOf("Cheddar cheese")).toBe("fat");
    expect(sidePartOf("Cream cheese")).toBe("fat");
    expect(sidePartOf("Olive oil")).toBe("fat");
    expect(sidePartOf("Butter")).toBe("fat");
  });
});
