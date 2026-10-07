/**
 * The fixed inputs the action-registry golden test replays through every per-kind surface: the
 * wire parse, the strict and replay schemas, grounding, history lines, fast-path copy and the
 * card. The recorded outputs under `__golden__/` were taken BEFORE the per-kind ActionSpec
 * registry existed, so any drift the registry introduces shows up as a diff.
 */
import type { CoachAction } from "@/lib/coach/actions";

export const TODAY = "2026-09-18";
export const REF1 = "3f1b1a2c-0000-4000-8000-000000000011";
export const REF2 = "3f1b1a2c-0000-4000-8000-000000000012";
export const REF3 = "3f1b1a2c-0000-4000-8000-000000000013";
export const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";

const food = {
  foodRefId: REF1, catalogFoodRevisionId: 77,
  kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
  verdict: "allowed" as const,
};
const chicken = { ...food, name: "chicken", grams: 150 };
const cake = { ...food, foodRefId: REF2, name: "cake", grams: 80, kcalPer100g: 390,
  proteinPer100g: 5, carbsPer100g: 55, fatPer100g: 17, verdict: "blocked" as const };

export const SAMPLE_ACTIONS: CoachAction[] = [
  { actionId: "a1", flagged: [], kind: "log_meal", date: TODAY, slot: "meal-1",
    title: "Chicken", items: [chicken] },
  { actionId: "a2", flagged: ["cake"], kind: "log_meal", date: TODAY, slot: "snack",
    title: "Cake & chicken", items: [chicken, cake], note: "after the run", at: "15:30" },
  { actionId: "a3", flagged: [], kind: "log_meal", date: TODAY, slot: "post-refuel",
    title: "Chicken", items: [chicken] },
  { actionId: "a4", flagged: [], kind: "add_slot_item", date: TODAY, slot: "meal-2", item: chicken },
  { actionId: "a5", flagged: [], kind: "remove_slot_item", date: TODAY, slot: "meal-3",
    ...food, name: "rice" },
  { actionId: "a6", flagged: [], kind: "set_slot_item", date: TODAY, slot: "meal-1",
    ...food, name: "chicken", grams: 200 },
  { actionId: "a7", flagged: [], kind: "move_slot", date: TODAY, slot: "hot-chocolate",
    time: "19:30" },
  { actionId: "a8", flagged: [], kind: "add_to_avoid", ...food, name: "Watermelon, raw",
    alsoFoodRefIds: [REF2, REF3] },
  { actionId: "a9", flagged: [], kind: "remove_from_avoid", ...food, name: "Watermelon, raw" },
  { actionId: "a10", flagged: [], kind: "set_slot_meal", date: TODAY, from: TODAY,
    through: "2026-09-20", dates: [TODAY, "2026-09-19", "2026-09-20"], title: "Tofu & rice",
    slot: "meal-4", items: [chicken, { ...chicken, name: "rice", grams: 160 }] },
  { actionId: "a11", flagged: [], kind: "delete_entry", entryId: ENTRY, what: "eggs at 09:00" },
  { actionId: "a12", flagged: [], kind: "move_entry", entryId: ENTRY, at: "13:30",
    what: "eggs at 09:00" },
  { actionId: "a13", flagged: [], kind: "save_recipe", name: "Chicken bowl", items: [chicken],
    refusals: ["No cake in a saved recipe."] },
  { actionId: "a14", flagged: [], kind: "shift_schedule", date: TODAY, minutes: 30,
    scope: "remaining" },
  { actionId: "a15", flagged: [], kind: "shift_schedule", date: TODAY, minutes: -45, scope: "all" },
  { actionId: "a16", flagged: [], kind: "log_water", date: TODAY, ml: 480 },
  { actionId: "a17", flagged: [], kind: "log_water", ml: 1500 },
  { actionId: "a18", flagged: [], kind: "log_weight", kg: 58.06 },
  { actionId: "a19", flagged: [], kind: "log_weight", date: TODAY, kg: 1234.5 },
  { actionId: "a20", flagged: [], kind: "update_profile", heightCm: 170, birthYear: 1992,
    sex: "female", trainingWeekdays: [1, 3] },
  { actionId: "a21", flagged: [], kind: "set_targets", dayType: "training", kcal: 2300 },
  { actionId: "a22", flagged: [], kind: "set_targets", dayType: "both", kcal: 2100, proteinG: 140 },
  { actionId: "a23", flagged: [], kind: "set_targets", dayType: "rest", kcal: null, proteinG: 150 },
  { actionId: "a24", flagged: [], kind: "add_to_eats", ...food, name: "salmon",
    roleAdvice: { foodRefId: REF1, suggestedRole: "protein_anchor", confidence: 0.9,
      requiresConfirmation: true } },
  { actionId: "a25", flagged: ["salmon"], kind: "remove_from_eats", ...food, name: "salmon" },
  { actionId: "a26", flagged: [], kind: "add_to_shopping_list", names: ["eggs", "oat milk"] },
];

/** An action kind a newer server may send an older phone (design §8.5). */
export const UNKNOWN_ACTION = {
  actionId: "a99", flagged: [], kind: "log_mood", mood: "fine",
} as unknown as CoachAction;

const empty = {
  date: "", from: "", through: "", weekdays: [], title: "", slot: "meal-1", items: [],
  item: { name: "", grams: 0 }, name: "", grams: 0, entryId: "", numericArgs: [], stringArgs: [],
};
const wire = (over: Record<string, unknown>) => ({ ...empty, ...over });

/** Provider-shaped replies (every key present) and a few lenient, hand-built ones. */
export const WIRE_SAMPLES: Record<string, unknown>[] = [
  wire({ kind: "log_meal", title: "Egg", stringArgs: ["09:00"],
    items: [{ name: "eggs", grams: 50 }] }),
  wire({ kind: "log_meal", title: "Egg", stringArgs: ["", "just a note"],
    items: [{ name: "eggs", grams: 50 }, { name: "", grams: 0 }] }),
  wire({ kind: "log_meal", items: [{ name: "eggs", grams: 50 }], slot: "snack" }),
  wire({ kind: "log_meal", title: "Egg", items: [{ name: "eggs", grams: 0 }] }),
  wire({ kind: "log_meal", title: "Egg", date: "2026-09-20", stringArgs: ["25:00"],
    items: [{ name: "eggs", grams: 50 }] }),
  { kind: "log_meal", title: "Egg", at: "08:15", note: "named", items: [{ name: "eggs", grams: 50 }],
    slot: "meal-1" },
  wire({ kind: "add_slot_item", item: { name: "rice", grams: 160 }, slot: "meal-2" }),
  wire({ kind: "add_slot_item", item: { name: "rice", grams: 0 }, slot: "meal-2" }),
  wire({ kind: "remove_slot_item", name: "rice", slot: "meal-3" }),
  wire({ kind: "set_slot_item", name: "rice", grams: 120, slot: "meal-3" }),
  wire({ kind: "move_slot", slot: "meal-3", stringArgs: ["13:30"] }),
  { kind: "move_slot", slot: "meal-3", time: "13:45" },
  wire({ kind: "move_slot", slot: "snack", stringArgs: ["13:30"] }),
  wire({ kind: "add_to_avoid", name: "watermelon" }),
  wire({ kind: "remove_from_avoid", name: "watermelon" }),
  wire({ kind: "set_slot_meal", from: TODAY, through: "2026-10-01", weekdays: [1, 2, 3, 4, 5],
    title: "Oatmeal", slot: "meal-1", items: [{ name: "oatmeal", grams: 0 },
      { name: "blueberries", grams: 80 }] }),
  wire({ kind: "set_slot_meal", from: TODAY, slot: "meal-1", items: [{ name: "oatmeal", grams: 0 }] }),
  wire({ kind: "set_slot_meal", date: "2026-09-21", title: "Eggs", slot: "meal-1",
    items: [{ name: "eggs", grams: 200 }] }),
  wire({ kind: "delete_entry", entryId: ENTRY }),
  wire({ kind: "delete_entry", entryId: "the eggs one" }),
  wire({ kind: "move_entry", entryId: ENTRY, stringArgs: ["13:30"] }),
  wire({ kind: "save_recipe", name: "Chicken bowl", items: [{ name: "chicken", grams: 150 }] }),
  wire({ kind: "shift_schedule", numericArgs: [30], stringArgs: ["remaining"] }),
  wire({ kind: "shift_schedule", numericArgs: [-45], stringArgs: ["all"] }),
  wire({ kind: "shift_schedule", numericArgs: [0], stringArgs: ["all"] }),
  wire({ kind: "shift_schedule", numericArgs: [30], stringArgs: ["one_slot"] }),
  wire({ kind: "log_water", numericArgs: [480] }),
  { kind: "log_water", ml: 250 },
  wire({ kind: "log_water", numericArgs: [0] }),
  wire({ kind: "log_water", numericArgs: [480.5] }),
  wire({ kind: "log_weight", numericArgs: [58.1] }),
  wire({ kind: "log_weight", date: "2026-09-17", numericArgs: [19] }),
  wire({ kind: "update_profile", numericArgs: [0, 0, 1992] }),
  wire({ kind: "update_profile", numericArgs: [170, 60, 0, 22, 1, 3, 5],
    stringArgs: ["female", "moderate", ""] }),
  wire({ kind: "update_profile", stringArgs: ["", "", "lose_fat"] }),
  wire({ kind: "update_profile" }),
  wire({ kind: "update_profile", stringArgs: ["other"] }),
  wire({ kind: "set_targets", numericArgs: [2300, 0], stringArgs: ["training"] }),
  wire({ kind: "set_targets", numericArgs: [0, 140], stringArgs: ["both"] }),
  { kind: "set_targets", dayType: "rest", kcal: null, proteinG: 150 },
  wire({ kind: "set_targets", numericArgs: [900], stringArgs: ["rest"] }),
  wire({ kind: "add_to_eats", name: "salmon", stringArgs: [REF1] }),
  wire({ kind: "remove_from_eats", name: "salmon", stringArgs: ["not-a-uuid"] }),
  wire({ kind: "remove_from_eats", name: "salmon" }),
  wire({ kind: "add_to_shopping_list", stringArgs: ["eggs", "oat milk"] }),
  wire({ kind: "add_to_shopping_list", stringArgs: [] }),
  { kind: "log_mood", mood: "fine" },
  { kind: "log_water", ml: 250, numericArgs: [480] },
];

/** Direct (application-side) inputs, including the legacy single-date meal aliases. */
export const STRICT_SAMPLES: Record<string, unknown>[] = [
  { kind: "log_meal", date: TODAY, slot: "meal-1", items: [{ name: "eggs", grams: 50 }] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "  Spaghetti   bolognese ",
    items: [{ name: "pasta", grams: 50 }] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", title: "x".repeat(41),
    items: [{ name: "pasta", grams: 50 }] },
  { kind: "log_meal", date: TODAY, slot: "meal-1", items: [{ name: "eggs", grams: 0 }] },
  { kind: "log_meal", date: "18/09/2026", slot: "meal-1", items: [{ name: "eggs", grams: 5 }] },
  { kind: "set_slot_meal", date: TODAY, slot: "meal-1", items: [{ name: "eggs" }] },
  { kind: "set_slot_meal", from: TODAY, through: "2026-09-25", weekdays: [7], slot: "meal-1",
    items: [{ name: "eggs" }] },
  { kind: "set_slot_item", date: TODAY, slot: "snack", name: "rice", grams: 10 },
  { kind: "update_profile", goalRateBpWeek: -50 },
  { kind: "update_profile", birthYear: 1850 },
  { kind: "update_profile" },
  { kind: "set_targets", dayType: "both" },
  { kind: "set_targets", dayType: "both", kcal: null },
  { kind: "shift_schedule", date: TODAY, minutes: 0, scope: "all" },
  { kind: "save_recipe", name: "Big", items: Array.from({ length: 12 },
    (_, i) => ({ name: `f${i}`, grams: 10 })) },
  { kind: "save_recipe", name: "Too big", items: Array.from({ length: 13 },
    (_, i) => ({ name: `f${i}`, grams: 10 })) },
  { kind: "add_to_eats", name: "salmon", foodRefId: REF1 },
  { kind: "move_entry", entryId: ENTRY, at: "9:00" },
  { kind: "add_to_shopping_list", names: ["eggs", "oat milk"] },
  { kind: "add_to_shopping_list", names: [] },
  { kind: "add_to_shopping_list", names: Array.from({ length: 21 }, (_, i) => `item${i}`) },
];

/** Stored rows replayed from the database, including legacy rows without titles or ranges. */
export const REPLAY_SAMPLES: Record<string, unknown>[] = [
  ...SAMPLE_ACTIONS.filter((action) => action.kind !== "update_profile"
    || !("bodyFatSource" in action)),
  { actionId: "r1", flagged: [], kind: "log_meal", date: TODAY, slot: "meal-1", items: [chicken] },
  { actionId: "r2", flagged: [], kind: "set_slot_meal", date: TODAY, slot: "meal-1",
    items: [chicken] },
  { actionId: "r3", flagged: [], kind: "update_profile", goalRateBpWeek: -25 },
  { actionId: "r4", flagged: [], kind: "update_profile", bodyFatSource: "scan" },
  UNKNOWN_ACTION as unknown as Record<string, unknown>,
];
