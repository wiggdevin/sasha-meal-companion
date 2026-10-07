/**
 * The meal library — the rotating options that fill each slot, plus the
 * Floor Day template. PRD §6.3, §7.2, §7.3; numbers transcribed from
 * `../../analysis/targets.md` §5 (per-slot targets) and §7 (Floor Day).
 *
 * GAP NOTE FOR THE BUILD REPORT: this file did not exist before this build
 * even though the PRD and the Today-screen brief both assume it. It is new
 * data, not a reimplementation of anything in plan.ts/targets.ts/scaling.ts —
 * those files are imported and used as-is (macroKcal for Atwater math). The
 * date -> meal rotation and swap precedence live in `lib/rotation.ts`, the
 * seam file between this library and plan.ts; this file only owns the raw
 * options (`getMealOptions`) and the Floor Day template (`FLOOR_DAY_MEALS`).
 *
 * MODELLING CHOICE: every FoodComponent here carries macros for ONE role
 * only (a "protein" item's macros are pure protein/fat, a "carb" item pure
 * carbs, a "fat" item pure fat) — real food is messier than that, but it
 * keeps each meal's macros == the exact sum of its components (enforced by
 * the `meal()` builder below, per the "must be validated by test" comment
 * on `Meal.macros` in types.ts) without hand-tuning kcal to match a
 * database. Every rotation option in a given (dayType, slot) hits the SAME
 * target macros as every other option in that slot — required by PRD §7.3
 * ("Swapping must NOT change the day's macro targets").
 *
 * Floor Day (§7.2/§7 "Floor Day") only replaces meal-1/meal-2/meal-3 — the
 * three real-food slots. Coffee, the pre-training carbs, the Wednesday
 * refuel and the optional hot chocolate stay untouched: they are already
 * zero-decision, ritual-sized items, so there is nothing to simplify away.
 */

import { macroKcal } from "./scaling";
import { ROTATION_EPOCH } from "./types";
import type { DayType, FoodComponent, Macros, Meal, MealTag, SlotId } from "./types";

// -------------------------------------------------------------- builders

function macros(protein: number, carbs: number, fat: number): Macros {
  return { protein, carbs, fat, kcal: macroKcal({ protein, carbs, fat }) };
}

function proteinItem(
  name: string,
  qty: number,
  unit: FoodComponent["unit"],
  protein: number,
  fat = 0
): FoodComponent {
  return { name, qty, unit, role: "protein", macros: macros(protein, 0, fat) };
}

function carbItem(
  name: string,
  qty: number,
  unit: FoodComponent["unit"],
  carbs: number
): FoodComponent {
  return { name, qty, unit, role: "carb", macros: macros(0, carbs, 0) };
}

function fatItem(
  name: string,
  qty: number,
  unit: FoodComponent["unit"],
  fat: number
): FoodComponent {
  return { name, qty, unit, role: "fat", macros: macros(0, 0, fat) };
}

function freeItem(
  name: string,
  qty: number,
  unit: FoodComponent["unit"],
  protein = 0,
  carbs = 0,
  fat = 0
): FoodComponent {
  return { name, qty, unit, role: "free", macros: macros(protein, carbs, fat) };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function meal(
  slot: SlotId,
  name: string,
  components: FoodComponent[],
  prepMinutes: number,
  tags: MealTag[] = []
): Meal {
  const totals = components.reduce(
    (acc, c) => ({
      protein: acc.protein + c.macros.protein,
      carbs: acc.carbs + c.macros.carbs,
      fat: acc.fat + c.macros.fat,
    }),
    { protein: 0, carbs: 0, fat: 0 }
  );

  return {
    id: `${slot}--${slugify(name)}`,
    name,
    slot,
    components,
    macros: macros(totals.protein, totals.carbs, totals.fat),
    prepMinutes,
    tags,
  };
}

// ---------------------------------------------------------------- labels

export const SLOT_LABELS: Record<SlotId, string> = {
  coffee: "Coffee",
  "pouches-pre": "Pre-training carbs",
  "post-refuel": "Post-training refuel",
  "meal-1": "Meal 1",
  "meal-2": "Meal 2",
  "meal-3": "Meal 3",
  "meal-4": "Meal 4",
  "meal-5": "Meal 5",
  "meal-6": "Meal 6",
  "hot-chocolate": "Hot chocolate",
};

// ------------------------------------------------------------ the library

const LOW_FIBRE: MealTag = "low-fibre";

const MEAL_LIBRARY: Record<DayType, Partial<Record<SlotId, Meal[]>>> = {
  "training-10": {
    coffee: [meal("coffee", "Latte", [freeItem("Espresso", 2, "oz", 0, 0, 0),
          freeItem("Oat milk", 1, "cup", 3, 17, 5)], 3)],
    "pouches-pre": [
      meal(
        "pouches-pre",
        "Banana + ½ cup melon",
        [freeItem("Banana, large", 1, "whole", 0.6, 30, 0),
          freeItem("Melon (cantaloupe)", 0.5, "cup", 0.4, 6, 0)],
        1,
        ["no-cook", LOW_FIBRE]
      ),
      meal(
        "pouches-pre",
        "White rice, ¾ cup",
        [freeItem("White rice, cooked", 0.75, "cup", 1, 36, 0)],
        2,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "pouches-pre",
        "Jasmine rice, ¾ cup",
        [freeItem("Jasmine rice, cooked", 0.75, "cup", 1, 36, 0)],
        2,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "pouches-pre",
        "Sweet potato, ¾ cup",
        [freeItem("Sweet potato, peeled & cooked", 0.75, "cup", 1, 36, 0)],
        2,
        ["leftovers-friendly"]
      ),
      meal(
        "pouches-pre",
        "Butternut squash + half a banana",
        [freeItem("Butternut squash, roasted", 1, "cup", 0.4, 21, 0),
          freeItem("Banana, medium (half)", 0.5, "whole", 0.6, 15, 0)],
        2,
        ["leftovers-friendly"]
      ),
    ],
    "meal-1": [
      meal(
        "meal-1",
        "Chicken, rice & avocado",
        [
          proteinItem("Chicken breast", 6, "oz", 45, 6),
          carbItem("White rice, cooked", 2, "cup", 75),
          fatItem("Avocado", 4, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-1",
        "Steak, sweet potato & avocado",
        [
          proteinItem("Sirloin steak", 6.5, "oz", 45, 10),
          carbItem("Sweet potato, peeled & cooked", 1.5, "cup", 75),
          fatItem("Avocado", 3, "tbsp", 17),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Albacore, potato & almond butter",
        [
          proteinItem("Canned albacore, drained", 6.4, "oz", 45, 4),
          carbItem("White potato, peeled & boiled", 1.5, "cup", 75),
          fatItem("Almond butter", 2.5, "tbsp", 23),
        ],
        15,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-1",
        "Ahi tuna, jasmine rice & olive oil",
        [
          proteinItem("Ahi tuna", 6, "oz", 45, 5),
          carbItem("Jasmine rice, cooked", 2, "cup", 75),
          fatItem("Olive oil", 1.6, "tbsp", 22),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-1",
        "Steak, butternut squash & almond butter",
        [
          proteinItem("Sirloin steak", 6.5, "oz", 45, 10),
          carbItem("Butternut squash, roasted", 2.2, "cup", 75),
          fatItem("Almond butter", 1.9, "tbsp", 17),
        ],
        25,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Ahi tuna, melon & avocado",
        [
          proteinItem("Ahi tuna", 6, "oz", 45, 5),
          carbItem("Melon", 2.5, "cup", 75),
          fatItem("Avocado", 2.4, "tbsp", 22),
        ],
        5,
        [LOW_FIBRE, "no-cook", "eat-out-ok"]
      ),
    ],
    "meal-2": [
      meal(
        "meal-2",
        "Steak, banana & avocado mayo",
        [
          proteinItem("Sirloin steak", 6.4, "oz", 45, 9),
          carbItem("Banana", 1.5, "whole", 38),
          fatItem("Avocado mayo", 2.5, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Ahi, melon & almond butter",
        [
          proteinItem("Ahi tuna", 6, "oz", 45, 5),
          carbItem("Melon", 1.5, "cup", 38),
          fatItem("Almond butter", 2.5, "tbsp", 27),
        ],
        15,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Albacore, rice & avocado",
        [
          proteinItem("Canned albacore, drained", 6.4, "oz", 45, 4),
          carbItem("White rice, cooked", 0.85, "cup", 38),
          fatItem("Avocado", 3.1, "tbsp", 28),
        ],
        15,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-2",
        "Chicken breast, sweet potato & olive oil",
        [
          proteinItem("Chicken breast", 6, "oz", 45, 6),
          carbItem("Sweet potato, peeled & cooked", 0.76, "cup", 38),
          fatItem("Olive oil", 3.06, "tbsp", 26),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-2",
        "Steak, jasmine rice & almond butter",
        [
          proteinItem("Sirloin steak", 6.4, "oz", 45, 9),
          carbItem("Jasmine rice, cooked", 1.01, "cup", 38),
          fatItem("Almond butter", 2.56, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Albacore, banana & avocado mayo",
        [
          proteinItem("Canned albacore, drained", 6.4, "oz", 45, 4),
          carbItem("Banana", 1.52, "whole", 38),
          fatItem("Avocado mayo", 3.08, "tbsp", 28),
        ],
        5,
        [LOW_FIBRE, "no-cook"]
      ),
    ],
    "meal-3": [
      meal(
        "meal-3",
        "Chicken, butternut & olive oil",
        [
          proteinItem("Chicken breast", 5.5, "oz", 41, 6),
          carbItem("Butternut squash, roasted", 1, "cup", 34),
          fatItem("Olive oil", 1.8, "tbsp", 25),
        ],
        25,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-3",
        "Steak, banana & avocado",
        [
          proteinItem("Sirloin steak", 5.9, "oz", 41, 8),
          carbItem("Banana", 1.3, "whole", 34),
          fatItem("Avocado", 2.3, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-3",
        "Ahi, melon & almond butter",
        [
          proteinItem("Ahi tuna", 5.5, "oz", 41, 4),
          carbItem("Melon", 1, "cup", 34),
          fatItem("Almond butter", 2.7, "tbsp", 27),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
      meal(
        "meal-3",
        "Albacore, sweet potato & avocado mayo",
        [
          proteinItem("Canned albacore, drained", 5.8, "oz", 41, 4),
          carbItem("Sweet potato, peeled & cooked", 0.68, "cup", 34),
          fatItem("Avocado mayo", 2.97, "tbsp", 27),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-3",
        "Chicken breast, jasmine rice & avocado",
        [
          proteinItem("Chicken breast", 5.5, "oz", 41, 6),
          carbItem("Jasmine rice, cooked", 0.91, "cup", 34),
          fatItem("Avocado", 2.78, "tbsp", 25),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-3",
        "Steak, potato & olive oil",
        [
          proteinItem("Sirloin steak", 5.9, "oz", 41, 8),
          carbItem("White potato, peeled & boiled", 0.92, "cup", 34),
          fatItem("Olive oil", 2.7, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE, "eat-out-ok"]
      ),
    ],
  },

  "training-7-fasted": {
    coffee: [meal("coffee", "Black coffee", [freeItem("Black coffee", 1, "cup")], 2)],
    "post-refuel": [
      meal(
        "post-refuel",
        "Shake + banana + latte",
        [
          proteinItem("Protein shake", 1, "whole", 29, 2),
          carbItem("Banana, large ×2", 2, "whole", 65),
          freeItem("Oat milk latte", 1, "cup", 1, 0, 10),
        ],
        3,
        ["no-cook"]
      ),
      meal(
        "post-refuel",
        "Shake + banana & melon + latte",
        [
          proteinItem("Protein shake", 1, "whole", 29, 2),
          carbItem("Banana, large", 1, "whole", 31),
          carbItem("Melon (cantaloupe)", 2.5, "cup", 34),
          freeItem("Oat milk latte", 1, "cup", 1, 0, 10),
        ],
        3,
        ["no-cook"]
      ),
      meal(
        "post-refuel",
        "Shake + banana & white rice + latte",
        [
          proteinItem("Protein shake", 1, "whole", 29, 2),
          carbItem("Banana, large", 1, "whole", 31),
          carbItem("White rice, cooked", 0.75, "cup", 34),
          freeItem("Oat milk latte", 1, "cup", 1, 0, 10),
        ],
        4,
        ["leftovers-friendly"]
      ),
      meal(
        "post-refuel",
        "Shake + banana & jasmine rice + latte",
        [
          proteinItem("Protein shake", 1, "whole", 29, 2),
          carbItem("Banana, large", 1, "whole", 31),
          carbItem("Jasmine rice, cooked", 0.75, "cup", 34),
          freeItem("Oat milk latte", 1, "cup", 1, 0, 10),
        ],
        4,
        ["leftovers-friendly"]
      ),
      meal(
        "post-refuel",
        "Shake + banana & sweet potato + latte",
        [
          proteinItem("Protein shake", 1, "whole", 29, 2),
          carbItem("Banana, large", 1, "whole", 31),
          carbItem("Sweet potato, peeled & cooked", 0.8, "cup", 34),
          freeItem("Oat milk latte", 1, "cup", 1, 0, 10),
        ],
        4,
        ["leftovers-friendly"]
      ),
    ],
    "meal-1": [
      meal(
        "meal-1",
        "Chicken, rice & avocado",
        [
          proteinItem("Chicken breast", 5.3, "oz", 40, 5),
          carbItem("White rice, cooked", 1.22, "cup", 55),
          fatItem("Avocado", 2.3, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-1",
        "Steak, potato & mayo",
        [
          proteinItem("Sirloin steak", 5.7, "oz", 40, 8),
          carbItem("White potato, peeled & boiled", 1.5, "cup", 55),
          fatItem("Avocado mayo", 2.2, "tbsp", 20),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Albacore, banana & almond butter",
        [
          proteinItem("Canned albacore, drained", 5.7, "oz", 40, 3),
          carbItem("Banana", 2, "whole", 55),
          fatItem("Almond butter", 2.8, "tbsp", 25),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-1",
        "Ahi tuna, sweet potato & olive oil",
        [
          proteinItem("Ahi tuna", 5.3, "oz", 40, 4),
          carbItem("Sweet potato, peeled & cooked", 1.1, "cup", 55),
          fatItem("Olive oil", 2.82, "tbsp", 24),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Chicken breast, jasmine rice & almond butter",
        [
          proteinItem("Chicken breast", 5.3, "oz", 40, 5),
          carbItem("Jasmine rice, cooked", 1.47, "cup", 55),
          fatItem("Almond butter", 2.56, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-1",
        "Albacore, melon & avocado mayo",
        [
          proteinItem("Canned albacore, drained", 5.7, "oz", 40, 3),
          carbItem("Melon", 1.83, "cup", 55),
          fatItem("Avocado mayo", 2.75, "tbsp", 25),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
    ],
    "meal-2": [
      meal(
        "meal-2",
        "Chicken, rice & olive oil",
        [
          proteinItem("Chicken breast", 4.7, "oz", 35, 5),
          carbItem("White rice, cooked", 1, "cup", 45),
          fatItem("Olive oil", 2.6, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-2",
        "Ahi, sweet potato & avocado",
        [
          proteinItem("Ahi tuna", 4.7, "oz", 35, 3),
          carbItem("Sweet potato, peeled & cooked", 0.9, "cup", 45),
          fatItem("Avocado", 2.5, "tbsp", 25),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Steak, banana & mayo",
        [
          proteinItem("Sirloin steak", 5, "oz", 35, 7),
          carbItem("Banana", 1.7, "whole", 45),
          fatItem("Avocado mayo", 2.1, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Albacore, jasmine rice & almond butter",
        [
          proteinItem("Canned albacore, drained", 4.9, "oz", 35, 3),
          carbItem("Jasmine rice, cooked", 1.2, "cup", 45),
          fatItem("Almond butter", 2.78, "tbsp", 25),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-2",
        "Chicken caesar wrap (GF, no parm), melon & avocado",
        [
          proteinItem("Chicken breast", 4.7, "oz", 35, 5),
          carbItem("Melon", 1.5, "cup", 45),
          fatItem("Avocado", 2.56, "tbsp", 23),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
      meal(
        "meal-2",
        "Steak, sweet potato & olive oil",
        [
          proteinItem("Sirloin steak", 5, "oz", 35, 7),
          carbItem("Sweet potato, peeled & cooked", 0.9, "cup", 45),
          fatItem("Olive oil", 2.47, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE, "eat-out-ok"]
      ),
    ],
    "meal-3": [
      meal(
        "meal-3",
        "Chicken, butternut & olive oil",
        [
          proteinItem("Chicken breast", 4, "oz", 30, 4),
          carbItem("Butternut squash, roasted", 1.03, "cup", 35),
          fatItem("Olive oil", 2.6, "tbsp", 23),
        ],
        25,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-3",
        "Steak, melon & avocado",
        [
          proteinItem("Sirloin steak", 4.3, "oz", 30, 6),
          carbItem("Melon", 1, "cup", 35),
          fatItem("Avocado", 2.4, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-3",
        "Albacore, rice & almond butter",
        [
          proteinItem("Canned albacore, drained", 4.3, "oz", 30, 3),
          carbItem("White rice, cooked", 0.78, "cup", 35),
          fatItem("Almond butter", 2.4, "tbsp", 24),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-3",
        "Ahi tuna, banana & avocado mayo",
        [
          proteinItem("Ahi tuna", 4, "oz", 30, 3),
          carbItem("Banana", 1.4, "whole", 35),
          fatItem("Avocado mayo", 2.64, "tbsp", 24),
        ],
        5,
        [LOW_FIBRE, "no-cook", "eat-out-ok"]
      ),
      meal(
        "meal-3",
        "Eggs & prosciutto, sweet potato & avocado",
        [
          proteinItem("Eggs ×4", 4, "whole", 26, 20),
          proteinItem("Prosciutto", 1, "oz", 4, 3),
          carbItem("Sweet potato, peeled & cooked", 0.7, "cup", 35),
          fatItem("Avocado", 0.44, "tbsp", 4),
        ],
        10,
        [LOW_FIBRE]
      ),
      meal(
        "meal-3",
        "Chicken breast, potato & olive oil",
        [
          proteinItem("Chicken breast", 4, "oz", 30, 4),
          carbItem("White potato, peeled & boiled", 0.95, "cup", 35),
          fatItem("Olive oil", 2.71, "tbsp", 23),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
    ],
  },

  rest: {
    coffee: [meal("coffee", "Latte", [freeItem("Espresso", 2, "oz", 0, 0, 0),
          freeItem("Oat milk", 1, "cup", 3, 17, 5)], 3)],
    "meal-1": [
      meal(
        "meal-1",
        "Chicken & avocado",
        [
          proteinItem("Chicken breast", 5.9, "oz", 44, 6),
          carbItem("Banana (half)", 0.5, "whole", 12),
          fatItem("Avocado", 2.3, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-1",
        "Steak & avocado",
        [
          proteinItem("Sirloin steak", 6.3, "oz", 44, 9),
          carbItem("Melon", 0.4, "cup", 12),
          fatItem("Avocado", 2, "tbsp", 18),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Ahi & almond butter",
        [
          proteinItem("Ahi tuna", 5.9, "oz", 44, 4),
          carbItem("Banana (half)", 0.5, "whole", 12),
          fatItem("Almond butter", 2.3, "tbsp", 23),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
      meal(
        "meal-1",
        "Albacore, melon & avocado mayo",
        [
          proteinItem("Canned albacore, drained", 6.2, "oz", 44, 4),
          carbItem("Melon", 0.4, "cup", 12),
          fatItem("Avocado mayo", 2.53, "tbsp", 23),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-1",
        "Steak, banana & avocado mayo",
        [
          proteinItem("Sirloin steak", 6.3, "oz", 44, 9),
          carbItem("Banana", 0.48, "whole", 12),
          fatItem("Avocado mayo", 2, "tbsp", 18),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-1",
        "Chicken breast, melon & almond butter",
        [
          proteinItem("Chicken breast", 5.9, "oz", 44, 6),
          carbItem("Melon", 0.4, "cup", 12),
          fatItem("Almond butter", 2.33, "tbsp", 21),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
    ],
    "meal-2": [
      meal(
        "meal-2",
        "Chicken, sweet potato & olive oil",
        [
          proteinItem("Chicken breast", 5.7, "oz", 43, 5),
          carbItem("Sweet potato, peeled & cooked", 0.44, "cup", 22),
          fatItem("Olive oil", 2.4, "tbsp", 22),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-2",
        "Steak, banana & avocado",
        [
          proteinItem("Sirloin steak", 6.1, "oz", 43, 8),
          carbItem("Banana", 0.8, "whole", 22),
          fatItem("Avocado", 2.1, "tbsp", 19),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-2",
        "Albacore, melon & almond butter",
        [
          proteinItem("Canned albacore, drained", 6.1, "oz", 43, 3),
          carbItem("Melon", 0.58, "cup", 22),
          fatItem("Almond butter", 2.4, "tbsp", 24),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-2",
        "Ahi tuna, sweet potato & avocado mayo",
        [
          proteinItem("Ahi tuna", 5.7, "oz", 43, 4),
          carbItem("Sweet potato, peeled & cooked", 0.44, "cup", 22),
          fatItem("Avocado mayo", 2.53, "tbsp", 23),
        ],
        15,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-2",
        "Chicken breast, banana & almond butter",
        [
          proteinItem("Chicken breast", 5.7, "oz", 43, 5),
          carbItem("Banana", 0.88, "whole", 22),
          fatItem("Almond butter", 2.44, "tbsp", 22),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-2",
        "Steak, melon & avocado mayo",
        [
          proteinItem("Sirloin steak", 6.1, "oz", 43, 8),
          carbItem("Melon", 0.73, "cup", 22),
          fatItem("Avocado mayo", 2.09, "tbsp", 19),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
    ],
    "meal-3": [
      meal(
        "meal-3",
        "Chicken, rice & avocado",
        [
          proteinItem("Chicken breast", 5.6, "oz", 42, 4),
          carbItem("White rice, cooked", 0.82, "cup", 37),
          fatItem("Avocado", 1.8, "tbsp", 16),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-3",
        "Steak, potato & mayo",
        [
          proteinItem("Sirloin steak", 6, "oz", 42, 6),
          carbItem("White potato, peeled & boiled", 1, "cup", 37),
          fatItem("Avocado mayo", 1.6, "tbsp", 14),
        ],
        20,
        [LOW_FIBRE]
      ),
      meal(
        "meal-3",
        "Ahi, banana & almond butter",
        [
          proteinItem("Ahi tuna", 5.6, "oz", 42, 3),
          carbItem("Banana", 1.5, "whole", 37),
          fatItem("Almond butter", 1.9, "tbsp", 17),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
      meal(
        "meal-3",
        "Albacore, sweet potato & olive oil",
        [
          proteinItem("Canned albacore, drained", 5.9, "oz", 42, 3),
          carbItem("Sweet potato, peeled & cooked", 0.74, "cup", 37),
          fatItem("Olive oil", 2, "tbsp", 17),
        ],
        10,
        [LOW_FIBRE, "no-cook"]
      ),
      meal(
        "meal-3",
        "Chicken breast, banana & avocado",
        [
          proteinItem("Chicken breast", 5.6, "oz", 42, 4),
          carbItem("Banana", 1.48, "whole", 37),
          fatItem("Avocado", 1.78, "tbsp", 16),
        ],
        20,
        [LOW_FIBRE, "leftovers-friendly"]
      ),
      meal(
        "meal-3",
        "Steak, melon & avocado mayo",
        [
          proteinItem("Sirloin steak", 6, "oz", 42, 6),
          carbItem("Melon", 1.06, "cup", 37),
          fatItem("Avocado mayo", 1.54, "tbsp", 14),
        ],
        15,
        [LOW_FIBRE, "eat-out-ok"]
      ),
    ],
    "hot-chocolate": [
      meal(
        "hot-chocolate",
        "Om mushroom hot chocolate",
        [freeItem("Om mushroom hot chocolate", 1, "cup", 0, 5, 1),
          freeItem("Oat milk", 1, "cup", 3, 17, 5)],
        3
      ),
    ],
  },
};

// -------------------------------------------------------------- floor day

/**
 * §7.2 / analysis §7 "Floor Day" — the three-item grab-and-go template.
 * Only meal-1/meal-2/meal-3 are replaced; see the file header for why.
 * Core total: 1,330 kcal / 106 g protein, matching the PRD exactly.
 *
 * A flat list, not a per-slot map — floor meals sit OUTSIDE the rotation
 * pools (they are not something the user rotates through, they are the escape
 * hatch for a bad day). Each meal already carries its own `slot`, so a
 * caller applying Floor Day matches on that. This shape (and the
 * `getMealOptions` shape below) is the contract `lib/rotation.ts` — the
 * date/slot seam that sits between this file and plan.ts — is written
 * against.
 */
export const FLOOR_DAY_MEALS: Meal[] = [
  meal(
    "meal-1",
    "4 eggs + banana",
    [proteinItem("Eggs ×4", 4, "whole", 26, 20), carbItem("Banana", 1, "whole", 29)],
    5,
    ["floor-day", "no-cook"]
  ),
  meal(
    "meal-2",
    "Albacore + sweet potato + avocado mayo",
    [
      proteinItem("Canned albacore, drained", 5, "oz", 35, 2),
      carbItem("Sweet potato, microwaved", 1, "cup", 40),
      fatItem("Avocado mayo", 2, "tbsp", 18),
    ],
    5,
    ["floor-day", "no-cook"]
  ),
  meal(
    "meal-3",
    "Pre-cooked chicken + rice + olive oil",
    [
      proteinItem("Chicken breast, pre-cooked", 6, "oz", 45, 6),
      carbItem("White rice, microwave pouch", 1, "cup", 36),
      fatItem("Olive oil", 1, "tbsp", 8),
    ],
    5,
    ["floor-day", "no-cook", "leftovers-friendly"]
  ),
];

/**
 * The `lib/foods.ts` food id each Floor Day component is built from, so
 * `resolveDay` can check their current Avoid list before substituting the
 * fixed template for a slot. Keyed by slot, in FLOOR_DAY_MEALS component
 * order. Not meant for any other use — Floor Day components carry a plain
 * name, not a food id, everywhere else.
 */
export const FLOOR_DAY_FOOD_IDS: Partial<Record<SlotId, string[]>> = {
  "meal-1": ["eggs", "banana"],
  "meal-2": ["canned-albacore", "sweet-potato", "avocado-mayo"],
  "meal-3": ["chicken-breast", "white-rice", "olive-oil"],
};

// ------------------------------------------------------------ public API

/**
 * The rotation options for a slot on a given day type. Empty if the slot
 * doesn't apply (e.g. "pouches-pre" on a rest day). Date -> index resolution
 * and swap precedence live in `lib/rotation.ts`, not here.
 */
export function getMealOptions(dayType: DayType, slot: SlotId): Meal[] {
  return MEAL_LIBRARY[dayType]?.[slot] ?? [];
}

export const MEAL_SLOTS: SlotId[] = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"];

export function isMealSlot(slot: SlotId): boolean {
  return MEAL_SLOTS.includes(slot);
}

/**
 * Per-slot macro targets (week-3 values), read off the authored library so
 * there is exactly one source. Every option in a slot shares these numbers,
 * so the first one is as good as any. targets.md §5.
 */
export const SLOT_TARGETS: Record<DayType, Partial<Record<SlotId, Macros>>> = Object.fromEntries(
  (Object.keys(MEAL_LIBRARY) as DayType[]).map((dayType) => [
    dayType,
    Object.fromEntries(
      (Object.keys(MEAL_LIBRARY[dayType]) as SlotId[]).map((slot) => [
        slot,
        { ...MEAL_LIBRARY[dayType][slot]![0].macros },
      ])
    ),
  ])
) as Record<DayType, Partial<Record<SlotId, Macros>>>;

// ---------------------------------------------------- resolveMeal (legacy)
//
// COMPAT NOTE FOR THE BUILD REPORT: app/week/page.tsx (built concurrently by
// a different agent against this same file) calls
// `resolveMeal(dayType, slot, date, { floorDay, swapMealId })` directly.
// lib/rotation.ts — built concurrently by a third agent — is the newer,
// tested seam for date -> meal resolution (`mealFor`/`mealsForDay`), and is
// what app/page.tsx (this build) uses. Rather than edit either of those
// off-limits files, this keeps the old signature alive as a thin wrapper.
//
// The day-diff math below is intentionally re-derived, not imported from
// lib/rotation.ts: both compute the UTC-millisecond difference between the
// same two calendar-date components, so they can never disagree, and
// re-deriving ~10 lines here avoids a circular import (rotation.ts already
// imports from this file).

function daysSinceEpochLocal(date: string, epoch: string): number {
  const [ey, em, ed] = epoch.split("-").map(Number);
  const [dy, dm, dd] = date.split("-").map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ey, em - 1, ed)) / 86_400_000);
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export type ResolveMealOptions = {
  floorDay?: boolean;
  /** A meal id from `swaps` in StoredDay — wins over both Floor Day and the rotation. */
  swapMealId?: string;
};

/** @deprecated Prefer `mealFor`/`mealsForDay` from lib/rotation.ts for new code. */
export function resolveMeal(
  dayType: DayType,
  slot: SlotId,
  date: string,
  options: ResolveMealOptions = {}
): Meal | undefined {
  const rotation = getMealOptions(dayType, slot);
  const floor = options.floorDay ? FLOOR_DAY_MEALS.find((m) => m.slot === slot) : undefined;

  if (options.swapMealId) {
    const pool = floor ? [floor, ...rotation] : rotation;
    const swapped = pool.find((m) => m.id === options.swapMealId);
    if (swapped) return swapped;
  }

  if (floor) return floor;
  if (rotation.length === 0) return undefined;

  const index = mod(daysSinceEpochLocal(date, ROTATION_EPOCH), rotation.length);
  return rotation[index];
}
