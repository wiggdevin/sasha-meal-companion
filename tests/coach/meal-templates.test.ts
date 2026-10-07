/**
 * Owner report, 2026-10-03: "High protein" for Meal 1 at 7:30 am gave "Scallops 387 g · Avocado
 * 93 g · Olive oil 5 g · Banana 77 g", another scallop card, and "Chicken breast 200 g · Banana
 * 81 g · Jasmine rice 50 g". Scallops and bananas always won, nothing was a real meal, there was no
 * vegetable and no sense of the time of day. These pin the rebuilt behaviour: meal types from the
 * slot clock, a pairing table, a vegetable role, plausible portions on 3- and 5-meal days, and
 * one card per anchor family.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import type { ComposedMeal } from "@/lib/coach/compose";
import { composeTemplateMeal } from "@/lib/coach/compose-template";
import { familyKey } from "@/lib/coach/meal-pairings";
import { clockLabel, mealTypeAt } from "@/lib/coach/meal-type";
import { portionBand } from "@/lib/coach/portion-bands";
import { suggestOptions } from "@/lib/coach/suggest";
import { orderAnchors } from "@/lib/coach/suggest-anchors";
import {
  F, FIVE_MEAL, OPEN_PROFILE, THREE_MEAL, food, searchOver, suggestPorts,
} from "@/tests/coach/meal-template-fixtures";

const ALL = Object.values(F);
const VEG = [F.broccoli.name, F.asparagus.name, F.spinach.name];
const names = (meal: ComposedMeal) => meal.items.map((item) => item.name);
const compose = (anchor: string, target: typeof FIVE_MEAL, mealType: "breakfast" | "dinner",
  foods = ALL, rotation = 0) => composeTemplateMeal("u1", {
  wish: anchor, slot: "meal-3", target, anchorProtein: anchor, mealType,
  mealClock: mealType === "breakfast" ? "07:30" : "19:00", rotation,
}, OPEN_PROFILE, { searchFoods: searchOver(foods), eatsNames: async () => foods.map((hit) => hit.name) });

describe("meal type from the slot clock", () => {
  it.each([
    ["07:30", "breakfast"], ["7:30 AM", "breakfast"], ["04:00", "breakfast"], ["10:29", "breakfast"],
    ["10:30", "lunch"], ["12:00", "lunch"], ["15:30", "snack"], ["19:00", "dinner"],
    ["7:00 pm", "dinner"], ["22:30", "other"], ["03:00", "other"], [null, "other"], ["soon", "other"],
  ] as const)("%s is %s", (clock, type) => {
    expect(mealTypeAt(clock)).toBe(type);
  });

  it("a snack request is a snack at any hour, and clocks read in either form", () => {
    expect(mealTypeAt("07:30", "snack")).toBe("snack");
    expect(clockLabel("7:05 PM")).toBe("19:05");
    expect(clockLabel("12:15 AM")).toBe("00:15");
  });
});

describe("the pairing table picks the sides", () => {
  it("a scallops dinner gets rice and a vegetable, never banana", async () => {
    const meal = await compose(F.scallopsSea.name, FIVE_MEAL, "dinner");
    expect(names(meal)).toContain(F.rice.name);
    expect(names(meal).some((name) => VEG.includes(name))).toBe(true);
    expect(names(meal)).not.toContain(F.banana.name);
    expect(names(meal)).not.toContain(F.blueberries.name);
    expect(meal.fitsTarget).toBe(true);
    expect(meal.mealType).toBe("dinner");
  });

  it("fruit is never the starch of a savoury main, even when it is the only carb on the list", async () => {
    const foods = [F.chicken, F.banana, F.blueberries, F.broccoli, F.oil];
    const meal = await compose(F.chicken.name, FIVE_MEAL, "dinner", foods);
    expect(names(meal)).not.toContain(F.banana.name);
    expect(names(meal)).not.toContain(F.blueberries.name);
  });

  it("Greek yogurt at breakfast goes with oats, fruit or nuts — not rice or broccoli", async () => {
    const meal = await compose(F.yogurt.name, FIVE_MEAL, "breakfast");
    const sides = names(meal).slice(1);
    expect(sides.every((name) => [F.oats.name, F.blueberries.name, F.banana.name, F.almonds.name,
      F.eggs.name].includes(name))).toBe(true);
    expect(meal.fitsTarget).toBe(true);
  });

  it("filler order rotates between cards, so one side is not on every plate", async () => {
    const starches = await Promise.all([0, 1, 2].map(async (rotation) =>
      names(await compose(F.chicken.name, FIVE_MEAL, "dinner", ALL, rotation))[1]));
    expect(new Set(starches).size).toBeGreaterThan(1);
  });

  it("composes without a vegetable when the Eats list has none, and invents nothing", async () => {
    const foods = ALL.filter((hit) => !VEG.includes(hit.name));
    const meal = await compose(F.chicken.name, FIVE_MEAL, "dinner", foods);
    expect(meal.items.length).toBeGreaterThan(1);
    expect(meal.items.every((item) => foods.some((hit) => hit.name === item.name))).toBe(true);
    expect(meal.fitsTarget).toBe(true);
  });

  it("still screens every added food: a gluten rule keeps the bread off a breakfast", async () => {
    const bread = food("Bread, white", [266, 8.9, 49, 3.3], { allergenTags: ["gluten"] });
    const foods = [F.eggs, bread, F.spinach, F.blueberries, F.yogurt, F.avocado];
    const meal = await composeTemplateMeal("u1", { wish: "x", slot: "meal-1", target: FIVE_MEAL,
      anchorProtein: F.eggs.name, mealType: "breakfast", mealClock: "07:30", rotation: 0 },
    { avoid_allergens: ["gluten"], avoid_food_ref_ids: [], banned_categories: [] },
    { searchFoods: searchOver(foods), eatsNames: async () => foods.map((hit) => hit.name) });
    expect(names(meal)).not.toContain(bread.name);
  });
});

describe("anchors suit the meal", () => {
  it("breakfast drops scallops, steak and white fish unless the person asks for them", () => {
    const anchors = [F.scallopsBay, F.scallopsSea, F.chicken, F.cod, F.steak, F.eggs, F.yogurt]
      .map((hit) => hit.name);
    const breakfast = orderAnchors(anchors, "breakfast", "High protein");
    expect(breakfast.slice(0, 2)).toEqual([F.eggs.name, F.yogurt.name]);
    expect(breakfast).not.toContain(F.scallopsSea.name);
    expect(breakfast).not.toContain(F.steak.name);
    expect(breakfast).not.toContain(F.cod.name);
    expect(orderAnchors(anchors, "breakfast", "scallops please")[0]).toBe(F.scallopsBay.name);
  });

  it("puts one of each family first: sea and bay scallops are one family", () => {
    expect(familyKey(F.scallopsSea.name)).toBe(familyKey(F.scallopsBay.name));
    const order = orderAnchors([F.scallopsBay.name, F.scallopsSea.name, F.chicken.name], "dinner", null);
    expect(order).toEqual([F.scallopsBay.name, F.chicken.name, F.scallopsSea.name]);
  });

  it("a 7:30 Meal 1 \"High protein\" gives eggs or yogurt breakfasts, never scallops or banana-with-meat", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3, slot: "meal-1", wish: "High protein" },
      suggestPorts({ target: FIVE_MEAL, clock: "07:30" }));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((card) => [F.eggs.name, F.yogurt.name].includes(card.items[0].name))).toBe(true);
    for (const card of cards) {
      expect(names(card).some((name) => /scallops|beef|cod/i.test(name))).toBe(false);
      expect(card.mealType).toBe("breakfast");
      expect(card.fitsTarget).toBe(true);
    }
  });
});

describe("three cards, three families", () => {
  it("no two dinner cards share an anchor family", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3, slot: "meal-3" },
      suggestPorts({ target: FIVE_MEAL, clock: "19:00" }));
    expect(cards).toHaveLength(3);
    const families = cards.map((card) => familyKey(card.items[0].name));
    expect(new Set(families).size).toBe(3);
  });
});

describe("plausible portions on 3- and 5-meal days", () => {
  it.each([["5-meal", FIVE_MEAL], ["3-meal", THREE_MEAL]] as const)(
    "%s dinner cards fit inside realistic servings with a vegetable side", async (_label, target) => {
      const cards = await suggestOptions({ kind: "meal", count: 3, slot: "meal-3" },
        suggestPorts({ target, clock: "19:00" }));
      expect(cards).toHaveLength(3);
      for (const card of cards) {
        expect(card.fitsTarget).toBe(true);
        expect(names(card).some((name) => VEG.includes(name))).toBe(true);
        for (const item of card.items) {
          const band = portionBand(item.name, item.part ?? "anchor");
          expect(item.grams).toBeLessThanOrEqual(band.max);
        }
        expect(card.items[0].grams).toBeLessThanOrEqual(250);
        const veg = card.items.find((item) => VEG.includes(item.name));
        expect(veg?.grams).toBeGreaterThanOrEqual(75);
        expect(veg?.grams).toBeLessThanOrEqual(200);
      }
    });

  it("a big 3-meal slot grows a side instead of a 387 g anchor", async () => {
    const meal = await compose(F.scallopsSea.name, THREE_MEAL, "dinner");
    expect(meal.items[0].grams).toBeLessThanOrEqual(250);
    expect(meal.items.length).toBeGreaterThanOrEqual(4);
    expect(meal.fitsTarget).toBe(true);
  });

  it("whole eggs stay whole eggs and never more than four", async () => {
    for (const target of [FIVE_MEAL, THREE_MEAL]) {
      const meal = await compose(F.eggs.name, target, "breakfast");
      const eggs = meal.items.find((item) => item.name === F.eggs.name);
      expect(eggs!.grams % 50).toBe(0);
      expect(eggs!.grams).toBeLessThanOrEqual(200);
    }
  });
});
