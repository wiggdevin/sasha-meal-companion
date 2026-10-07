/** Phase 18 W6 UI: the swap sheet's own slate builder. */
import { describe, expect, it } from "vitest";
import { currentMealKey, swapOptionKey, swapSignalEvents } from "@/components/signals/swap-sheet-signals";
import type { Food } from "@/lib/foods";
import type { FoodComponent } from "@/lib/types";
import type { SwapAlternative } from "@/lib/today/swap-alternatives";

function food(id: string, catalogFoodId?: number): Food {
  return { id, name: id, role: "protein", unit: "oz", perUnit: { protein: 7, carbs: 0, fat: 1 },
    status: "eats", updatedAt: "2026-10-01T00:00:00Z", ...(catalogFoodId ? { catalogFoodId } : {}) };
}

function option(id: string, proteinKey: string, source: SwapAlternative["source"] = "Your foods"): SwapAlternative {
  return { id, name: id, source, components: [], macros: { kcal: 400, protein: 30, carbs: 40, fat: 10 },
    proteinKey, foodIds: [proteinKey] };
}

const chicken = food("chicken-1");
const salmon = food("salmon-1", 555);
const foods: Record<string, Food> = { "chicken-1": chicken, "salmon-1": salmon };

describe("swapOptionKey", () => {
  it("resolves an option's protein ingredient against the account's own foods", () => {
    expect(swapOptionKey(option("plate:a", "chicken-1"), foods)).toBe("food:chicken-1");
    // An account row keys by its own id even when it was made from a catalog food (food-key.ts).
    expect(swapOptionKey(option("recipe:1", "salmon-1"), foods)).toBe("food:salmon-1");
  });

  it("is undefined for an anchorless fallback id or a stale protein no longer in foods", () => {
    expect(swapOptionKey(option("plate:b", "plate:xyz"), foods)).toBeUndefined();
    expect(swapOptionKey(option("recipe:2", "gone"), foods)).toBeUndefined();
  });
});

describe("currentMealKey", () => {
  it("reads the protein component's own foodKey", () => {
    const components: FoodComponent[] = [
      { name: "Chicken", qty: 6, unit: "oz", role: "protein", macros: { kcal: 280, protein: 42, carbs: 0, fat: 6 },
        foodKey: "food:chicken-1" },
      { name: "Rice", qty: 1, unit: "cup", role: "carb", macros: { kcal: 200, protein: 4, carbs: 45, fat: 0 } },
    ];
    expect(currentMealKey(components)).toBe("food:chicken-1");
  });

  it("is undefined when the protein line carries no foodKey (a custom or edited meal)", () => {
    const components: FoodComponent[] = [
      { name: "Chicken", qty: 6, unit: "oz", role: "protein", macros: { kcal: 280, protein: 42, carbs: 0, fat: 6 } },
    ];
    expect(currentMealKey(components)).toBeUndefined();
  });
});

const currentComponents: FoodComponent[] = [
  { name: "Turkey", qty: 6, unit: "oz", role: "protein", macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 },
    foodKey: "food:turkey-1" },
];
const turkeyFoods: Record<string, Food> = { ...foods, "turkey-1": food("turkey-1") };
const shownOptions = [option("plate:a", "chicken-1"), option("recipe:1", "salmon-1")];

describe("swapSignalEvents", () => {
  it("sends swapped_away and picked sharing one slate, the replaced meal's key included", () => {
    const events = swapSignalEvents({ slateId: "s1", currentComponents, shownOptions,
      chosenOption: shownOptions[0], foods: turkeyFoods, occasion: "dinner" });
    expect(events).toEqual([
      { slateId: "s1", surface: "swap_sheet", kind: "swapped_away", occasion: "dinner",
        chosenKey: "food:turkey-1",
        offeredKeys: ["food:chicken-1", "food:salmon-1", "food:turkey-1"],
        rankingVersion: "swap-sheet-v1" },
      { slateId: "s1", surface: "swap_sheet", kind: "picked", occasion: "dinner",
        chosenKey: "food:chicken-1",
        offeredKeys: ["food:chicken-1", "food:salmon-1", "food:turkey-1"],
        rankingVersion: "swap-sheet-v1" },
    ]);
  });

  it("keeps every shown option in the slate even when a full 8-option carousel plus the " +
    "replaced meal would otherwise exceed SIGNAL_SLATE_MAX (Sol review r1, BLOCK 2)", () => {
    const eight = Array.from({ length: 8 }, (_, i) => option(`plate:${i}`, `shown-${i}`));
    const eightFoods: Record<string, Food> = Object.fromEntries(eight.map((opt) =>
      [opt.proteinKey, food(opt.proteinKey)]));
    const events = swapSignalEvents({ slateId: "s1", currentComponents, shownOptions: eight,
      chosenOption: eight[7], foods: { ...eightFoods, "turkey-1": food("turkey-1") },
      occasion: "dinner" });
    // The 8th (last) visible option is still a resolvable pick: its key must survive the cap.
    const picked = events.find((event) => event.kind === "picked");
    expect(picked?.chosenKey).toBe("food:shown-7");
    expect(picked?.offeredKeys).toEqual(eight.map((opt) => `food:${opt.proteinKey}`));
    // The replaced meal's own key had no room left, so swapped_away is correctly left out —
    // never a fabricated or truncated slate.
    expect(events.some((event) => event.kind === "swapped_away")).toBe(false);
  });

  it("sends only picked when the replaced meal has no resolvable key", () => {
    const noKeyComponents: FoodComponent[] = [
      { name: "Turkey", qty: 6, unit: "oz", role: "protein", macros: { kcal: 260, protein: 40, carbs: 0, fat: 5 } },
    ];
    const events = swapSignalEvents({ slateId: "s1", currentComponents: noKeyComponents, shownOptions,
      chosenOption: shownOptions[0], foods, occasion: "dinner" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("picked");
  });

  it("sends nothing when the chosen option is not in the slate (not a resolvable key, or not shown)", () => {
    const events = swapSignalEvents({ slateId: "s1", currentComponents, shownOptions,
      chosenOption: option("plate:c", "plate:xyz"), foods: turkeyFoods, occasion: "dinner" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("swapped_away");
  });

  it("caps the slate at SIGNAL_SLATE_MAX distinct keys", () => {
    const many = Array.from({ length: 10 }, (_, i) => option(`plate:${i}`, `food-${i}`));
    const manyFoods: Record<string, Food> = Object.fromEntries(many.map((option) =>
      [option.proteinKey, food(option.proteinKey)]));
    const events = swapSignalEvents({ slateId: "s1", currentComponents: [], shownOptions: many,
      chosenOption: many[0], foods: manyFoods, occasion: "lunch" });
    expect(events[0].offeredKeys).toHaveLength(8);
  });

  it("sends signals for a mixed slate (a saved recipe or saved meal alongside ranked plates), " +
    "naming SWAP_SHEET_RANKING_VERSION rather than the ranking engine's own o2.1 (W6 PR #466: " +
    "the real allowlisted identifier replaces the Sol r3 interim all-ranked-plates gate)", () => {
    const mixed = [option("plate:a", "chicken-1"), option("recipe:1", "salmon-1", "Your recipe")];
    const events = swapSignalEvents({ slateId: "s1", currentComponents, shownOptions: mixed,
      chosenOption: mixed[1], foods: turkeyFoods, occasion: "dinner" });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.rankingVersion === "swap-sheet-v1")).toBe(true);
    const picked = events.find((event) => event.kind === "picked");
    expect(picked?.chosenKey).toBe("food:salmon-1");
  });

  it("still sends signals for an all-generated-plate slate, same rankingVersion", () => {
    const allPlates = [option("plate:a", "chicken-1"), option("plate:b", "salmon-1")];
    const events = swapSignalEvents({ slateId: "s1", currentComponents, shownOptions: allPlates,
      chosenOption: allPlates[0], foods: turkeyFoods, occasion: "dinner" });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.rankingVersion === "swap-sheet-v1")).toBe(true);
  });
});
