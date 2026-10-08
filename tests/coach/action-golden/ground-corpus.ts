/**
 * Grounding inputs for the action-registry golden test, and deterministic ports for them: a fake
 * catalog with an allowed food, a blocked one, a concentrate, a food with no portion and a miss.
 */
import type { CoachActionInput, GroundActionPorts } from "@/lib/coach/actions";
import type { FoodHit } from "@/lib/coach/executors";
import { ENTRY, REF1, REF2, REF3, TODAY } from "@/tests/coach/action-golden/corpus";

const hit = (over: Partial<FoodHit>): FoodHit => ({
  foodRefId: REF1, name: "Chicken breast, cooked", brand: null, kcalPer100g: 165,
  prefStatus: null, catalogFoodRevisionId: 77, proteinPer100g: 31, carbsPer100g: 0,
  fatPer100g: 3.6, portionGrams: 120, ...over,
} as FoodHit);

const CATALOG: Record<string, FoodHit[]> = {
  chicken: [hit({})],
  cake: [hit({ foodRefId: REF2, name: "Cake, chocolate", kcalPer100g: 390,
    category: ["simple_sugars"] })],
  "protein shake": [hit({ foodRefId: REF3, name: "Protein powder, whey", portionGrams: 30,
    portionLabel: "1 scoop" } as Partial<FoodHit>)],
  yogurt: [hit({ foodRefId: REF2, name: "Yogurt, plain", portionGrams: null }),
    hit({ foodRefId: REF3, name: "Yogurt, Greek", portionGrams: 150 })],
  plainrice: [hit({ foodRefId: REF2, name: "Rice, plain", portionGrams: null })],
  watermelon: [hit({ foodRefId: REF2, name: "Watermelon, raw", prefStatus: "avoid" })],
  salmon: [hit({ foodRefId: REF3, name: "Salmon, Atlantic", prefStatus: "eats" })],
  nullref: [hit({ foodRefId: null, name: "Unlinked" })],
};

export function groundPorts(over: Partial<GroundActionPorts> = {}): GroundActionPorts {
  let next = 0;
  return {
    searchFoods: async (_userId, query, limit) => (CATALOG[query] ?? []).slice(0, limit),
    newActionId: () => `g${(next += 1)}`,
    knownEntries: async () => new Map([[ENTRY, "eggs at 09:00"]]),
    sameNameRefIds: async () => [REF1, REF2, REF3],
    ...over,
  };
}

const item = (name: string, grams?: number) => (grams === undefined ? { name } : { name, grams });

export const GROUND_SAMPLES: CoachActionInput[] = [
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "Chicken", items: [item("chicken", 150)] },
  { kind: "log_meal", date: TODAY, slot: "snack", items: [item("chicken", 150), item("cake", 80)],
    at: "15:30", note: "after the run" },
  { kind: "log_meal", date: TODAY, slot: "meal-1", items: [item("mystery", 50)] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "Shake",
    items: [item("protein shake", 300)] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "Shake",
    items: [item("protein shake", 30)] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "Linked", items: [item("nullref", 30)] },
  { kind: "add_slot_item", date: TODAY, slot: "meal-2", item: { name: "cake", grams: 80 } },
  { kind: "remove_slot_item", date: TODAY, slot: "meal-2", name: "chicken" },
  { kind: "remove_slot_item", date: TODAY, slot: "meal-2", name: "mystery" },
  { kind: "set_slot_item", date: TODAY, slot: "meal-2", name: "cake", grams: 40 },
  { kind: "move_slot", date: TODAY, slot: "meal-3", time: "19:30" },
  { kind: "add_to_avoid", name: "watermelon" },
  { kind: "remove_from_avoid", name: "cake" },
  { kind: "add_to_eats", name: "cake" },
  { kind: "remove_from_eats", name: "cake" },
  { kind: "add_to_eats", name: "mystery" },
  { kind: "set_slot_meal", from: TODAY, through: "2026-09-24", weekdays: [1, 3], slot: "meal-1",
    title: "Yogurt bowl", items: [item("yogurt"), item("chicken")] },
  { kind: "set_slot_meal", date: TODAY, slot: "meal-1", items: [item("chicken", 100)] },
  { kind: "set_slot_meal", from: TODAY, slot: "meal-1", title: "Rice", items: [item("plainrice")] },
  { kind: "set_slot_meal", from: TODAY, through: "2026-11-30", slot: "meal-1", title: "Long",
    items: [item("chicken", 100)] },
  { kind: "set_slot_meal", from: TODAY, through: "2026-09-10", slot: "meal-1", title: "Back",
    items: [item("chicken", 100)] },
  { kind: "set_slot_meal", from: TODAY, through: TODAY, weekdays: [0], slot: "meal-1",
    title: "None", items: [item("chicken", 100)] },
  { kind: "delete_entry", entryId: ENTRY },
  { kind: "delete_entry", entryId: REF1 },
  { kind: "move_entry", entryId: ENTRY, at: "13:30" },
  { kind: "save_recipe", name: "Bowl", items: [item("chicken", 150), item("cake", 30)] },
  { kind: "save_recipe", name: "Bowl", items: [item("mystery", 150)] },
  { kind: "shift_schedule", date: TODAY, minutes: 30, scope: "remaining" },
  { kind: "log_water", ml: 480 },
  { kind: "log_weight", date: TODAY, kg: 58.1 },
  { kind: "update_profile", birthYear: 1992, sex: "female" },
  { kind: "set_targets", dayType: "both", kcal: 2100, proteinG: null },
  { kind: "add_to_shopping_list", names: ["eggs", "oat milk"] },
  { kind: "set_shopping_focus", on: true, days: 10 },
  { kind: "set_shopping_focus", on: false },
] as CoachActionInput[];
