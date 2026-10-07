import { describe, expect, it } from "vitest";
import { mealCountFor, resolveSlotTimes, slotListFor } from "./plan";
import { defaultSettings } from "./store";
import { eatenSlotsSchema, itemOverridesSchema } from "./sync/plan-days-schema";
import { logCommitRequestSchema } from "./log/contract";

describe("account meal layout", () => {
  it("derives a meal count from the account's training target and accepts an explicit choice", () => {
    const settings = defaultSettings();
    expect(mealCountFor(settings)).toBe(3);
    settings.activeTargetProfile = {
      training: { kcal: 2400, protein: 140, carbs: 280, fat: 80 },
      rest: { kcal: 2000, protein: 140, carbs: 180, fat: 80 },
    };
    expect(mealCountFor(settings)).toBe(4);
    settings.mealsPerDay = 6;
    expect(mealCountFor(settings)).toBe(6);
  });

  it("shows only account meal slots and preserves per-slot time overrides", () => {
    const settings = { ...defaultSettings(), mealsPerDay: 5, shiftMinutes: 15,
      slotTimes: { "meal-4": "18:00" } } as const;
    expect(slotListFor("training-10", settings)).toEqual([
      "meal-1", "meal-2", "meal-3", "meal-4", "meal-5",
    ]);
    expect(slotListFor("rest", settings)).toEqual(slotListFor("training-10", settings));
    expect(resolveSlotTimes("rest", settings)).toEqual([
      { slot: "meal-1", time: "07:45" },
      { slot: "meal-2", time: "10:45" },
      { slot: "meal-3", time: "13:45" },
      { slot: "meal-4", time: "18:15" },
      { slot: "meal-5", time: "19:45" },
    ]);
  });

  it("accepts the sixth meal in synced marks and a food log", () => {
    expect(eatenSlotsSchema.safeParse({ "meal-6": {
      eaten_at: "2026-09-26T12:00:00Z", changed_at: "2026-09-26T12:00:00Z",
    } }).success).toBe(true);
    expect(logCommitRequestSchema.safeParse({
      entry_id: "00000000-0000-4000-8000-000000000001", eaten_at: "2026-09-26T12:00:00Z",
      tz: "America/Denver", local_date: "2026-09-26", slot: "meal-6", method: "plan",
      items: [{ id: "00000000-0000-4000-8000-000000000002", seq: 0,
        food_ref_id: "00000000-0000-4000-8000-000000000003", qty: 1, unit: "cup", grams: 160 }],
    }).success).toBe(true);
  });

  it("syncs per-date add and remove markers without a meal item", () => {
    const parsed = itemOverridesSchema.safeParse({
      "meal-5": { baseMealId: null, components: [], added: true },
      "meal-6": { baseMealId: null, components: [], removed: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data["meal-5"]?.added).toBe(true);
      expect(parsed.data["meal-6"]?.removed).toBe(true);
    }
  });
});
