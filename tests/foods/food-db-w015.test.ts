/**
 * W015 (audit 2026-10-10 F09: A020, A021): the bundled list's default portion is one sensible
 * serving, chosen by scripts/build-food-db.py, and the two meal rows the audit found on the wrong
 * SR row are rebuilt from SR ingredient rows.
 */
import { describe, expect, it } from "vitest";
import { dbFood, FOOD_DB, portionsFor, searchFoods } from "@/lib/food-db";

const defaultOf = (id: string) => {
  const hit = searchFoods(dbFood(id)!.name, {}, 50).find((row) => row.id === id);
  if (!hit) throw new Error(`${id} not found`);
  return hit.defaultPortion!;
};

describe("default portion is a sensible serving (A020)", () => {
  it.each([
    ["egg-yolk", /large/], ["almonds", /oz/], ["m-m-s", /package|box|serving/], ["flour-tortilla", /tortilla/],
    ["pizza-pepperoni", /0\.25 pizza/], ["milk-chocolate", /bar \(1\.55 oz\)/], ["omelet-cheese", /large/],
  ])("%s defaults to %s", (id, label) => {
    expect(defaultOf(id).label).toMatch(label);
  });

  it.each(["egg-yolk", "almonds", "m-m-s", "flour-tortilla", "pizza-pepperoni", "general-tso-s-chicken",
    "milk-chocolate", "chocolate-chips"])("%s defaults under 700 kcal", (id) => {
    expect(defaultOf(id).kcal!).toBeLessThan(700);
  });

  it("marks exactly one default on every bundled food, and the build agrees with the reader", () => {
    for (const food of FOOD_DB) {
      const marked = food.portions.filter((p) => p.isDefault);
      expect(marked.length, food.id).toBe(1);
      expect(portionsFor(food)[0].label, food.id).toBe(marked[0].label);
      expect(defaultOf(food.id).label, food.id).toBe(marked[0].label);
    }
  });

  it("keeps the everyday portions people already rely on", () => {
    expect(portionsFor(dbFood("egg-whole-large")!)[0].label).toMatch(/medium|large/);
    expect(portionsFor(dbFood("olive-oil")!)[0].label).toMatch(/tablespoon|tbsp/);
    expect(portionsFor(dbFood("banana")!)[0].label).toMatch(/medium/);
  });
});

describe("meal rows on the right SR rows (A021)", () => {
  it("builds a ramen bowl as prepared noodles in broth, not the dry block", () => {
    const ramen = dbFood("ramen-bowl")!;
    expect(ramen.sr).toMatch(/^recipe: .*Soup, ramen noodle.*dry.*Water/);
    expect(ramen.per100g.kcal).toBeGreaterThan(40);
    expect(ramen.per100g.kcal).toBeLessThan(120);
    const bowl = defaultOf("ramen-bowl");
    expect(bowl.label).toMatch(/bowl/);
    expect(bowl.kcal!).toBeGreaterThan(300);
    expect(bowl.kcal!).toBeLessThan(500);
  });

  it("builds overnight oats from dry oats soaked in milk, not oatmeal cooked in water", () => {
    const oats = dbFood("overnight-oats")!;
    expect(oats.sr).toMatch(/^recipe: .*oats.*dry.*Milk/);
    expect(oats.sr).not.toMatch(/cooked with water/);
    expect(oats.per100g.kcal).toBeGreaterThan(100);
    expect(oats.per100g.protein).toBeGreaterThan(4);
    expect(oats.flags).toContain("dairy");
  });
});
