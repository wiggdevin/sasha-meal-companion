/**
 * Eats fixtures for the lib/meals tests: per-gram macros (USDA per 100 g ÷ 100), unit "g", so the
 * portion bands read in grams with no unit table in the way.
 */
import type { Food } from "@/lib/foods";
import type { Plate } from "@/lib/meals/plate";
import { pairScore, PAIR_FLOOR } from "@/lib/meals/affinity";
import { partsOf, withinBand } from "@/lib/meals/parts";

export function food(id: string, name: string, role: Food["role"], per100: [number, number, number]): Food {
  const [protein, carbs, fat] = per100;
  return { id, name, role, unit: "g", status: "eats", updatedAt: "2026-10-04",
    perUnit: { protein: protein / 100, carbs: carbs / 100, fat: fat / 100 } };
}

export const F = {
  eggs: food("eggs", "Eggs, whole, cooked", "protein", [12.6, 0.7, 9.5]),
  yogurt: food("yogurt", "Greek yogurt, plain, nonfat", "protein", [10, 3.6, 0.4]),
  oats: food("oats", "Oats, rolled", "carb", [13, 68, 6.5]),
  toast: food("toast", "Toast, whole wheat", "carb", [13, 43, 4.5]),
  tuna: food("tuna", "Tuna, canned in water", "protein", [25, 0, 1]),
  banana: food("banana", "Banana", "carb", [1.1, 23, 0.3]),
  blueberries: food("blueberries", "Blueberries", "carb", [0.7, 14, 0.3]),
  rice: food("rice", "Rice, white, cooked", "carb", [2.7, 28, 0.3]),
  broccoli: food("broccoli", "Broccoli, steamed", "carb", [2.4, 7, 0.4]),
  oliveOil: food("olive-oil", "Olive oil", "fat", [0, 0, 100]),
  almonds: food("almonds", "Almonds", "fat", [21, 22, 50]),
  chicken: food("chicken", "Chicken breast, roasted", "protein", [31, 0, 3.6]),
  lentils: food("lentils", "Lentils, cooked", "protein", [9, 20, 0.4]),
  quorn: food("quorn", "Quorn pieces", "protein", [14, 4.5, 2.6]),
  // South Asian
  dal: food("dal", "Dal (lentil curry)", "protein", [9, 20, 3]),
  paneer: food("paneer", "Paneer", "protein", [18, 3, 20]),
  roti: food("roti", "Roti", "carb", [9, 46, 7]),
  spinach: food("spinach", "Spinach, cooked", "carb", [3, 3.8, 0.3]),
  ghee: food("ghee", "Ghee", "fat", [0, 0, 100]),
  // East Asian
  tofu: food("tofu", "Tofu, firm", "protein", [17, 3, 9]),
  bokChoy: food("bok-choy", "Bok choy, cooked", "carb", [1.6, 1.8, 0.2]),
  sesameOil: food("sesame-oil", "Sesame oil", "fat", [0, 0, 100]),
  // Latin American
  blackBeans: food("black-beans", "Black beans, cooked", "protein", [8.9, 23.7, 0.5]),
  tortilla: food("tortilla", "Corn tortilla", "carb", [5.7, 45, 2.8]),
  avocado: food("avocado", "Avocado", "fat", [2, 8.5, 14.7]),
  // Mediterranean
  chickpeas: food("chickpeas", "Chickpeas, cooked", "protein", [8.9, 27, 2.6]),
  feta: food("feta", "Feta cheese", "fat", [14, 4, 21]),
  bread: food("bread", "Bread, whole wheat", "carb", [13, 41, 3.4]),
  tomato: food("tomato", "Tomato", "carb", [0.9, 3.9, 0.2]),
} as const;

export const eats = (...foods: Food[]): Record<string, Food> =>
  Object.fromEntries(foods.map((item) => [item.id, item]));

export const BREAKFAST = { kcal: 500, protein: 35, carbs: 55, fat: 14 };
export const MAIN = { kcal: 650, protein: 45, carbs: 70, fat: 20 };

/** The template and coherence rules a generated plate must keep, as a list of broken rules. */
export function brokenRules(plate: Plate): string[] {
  const broken: string[] = [];
  const parts = plate.rows.map((row) => row.part);
  const anchor = plate.rows.find((row) => row.part === "anchor");
  const legume = !!anchor && partsOf(anchor.food).includes("starch");
  if (plate.template === "breakfast") {
    if (!anchor) broken.push("breakfast without an anchor");
    if (!legume && !parts.includes("starch") && !parts.includes("fruit")) broken.push("breakfast without starch or fruit");
  }
  if (plate.template === "main") {
    if (!anchor) broken.push("main without an anchor");
    if (!legume && !parts.includes("starch")) broken.push("main without a starch");
    if (parts.includes("fruit")) broken.push("fruit on a main");
  }
  if (plate.template === "snack" && !anchor && !(parts.includes("fruit") && parts.includes("fat"))) {
    broken.push("snack without an anchor or fruit and fat");
  }
  for (const row of plate.rows) {
    if (!withinBand(row.food, row.part, row.qty)) broken.push(`${row.food.name} ${row.qty} outside its band`);
    if (row.part !== "anchor"
      && pairScore(anchor?.food ?? null, row.food, row.part, plate.template, plate.occasion).score < PAIR_FLOOR) {
      broken.push(`${row.food.name} does not pair`);
    }
  }
  if (new Set(plate.rows.map((row) => row.food.id)).size !== plate.rows.length) broken.push("a food twice");
  return broken;
}
