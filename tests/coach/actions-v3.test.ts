import { describe, expect, it } from "vitest";
import { assertSupported } from "@/lib/ai/json-schema";
import {
  ACTION_KINDS,
  coachActionSchema,
  coachActionWireSchema,
  flatCoachActionSchema,
  providerActionSchema,
} from "@/lib/coach/actions";

const TODAY = "2026-09-19";

describe("the T4 action kinds", () => {
  const cases = [
    {
      kind: "shift_schedule",
      good: { kind: "shift_schedule", date: TODAY, minutes: 30, scope: "remaining" },
      bad: { kind: "shift_schedule", date: TODAY, minutes: 0, scope: "remaining" },
    },
    {
      kind: "log_water",
      good: { kind: "log_water", date: TODAY, ml: 480 },
      bad: { kind: "log_water", date: TODAY, ml: 0 },
    },
    {
      kind: "log_weight",
      good: { kind: "log_weight", date: TODAY, kg: 58.1 },
      bad: { kind: "log_weight", date: TODAY, kg: 19.9 },
    },
    {
      kind: "update_profile",
      good: { kind: "update_profile", heightCm: 165, activityLevel: "moderate" },
      bad: { kind: "update_profile" },
    },
    {
      kind: "set_targets",
      good: { kind: "set_targets", dayType: "training", kcal: 2300 },
      bad: { kind: "set_targets", dayType: "training" },
    },
    {
      kind: "add_to_eats",
      good: { kind: "add_to_eats", name: "salmon" },
      bad: { kind: "add_to_eats", name: "" },
    },
    {
      kind: "remove_from_eats",
      good: { kind: "remove_from_eats", name: "salmon" },
      bad: { kind: "remove_from_eats", name: "" },
    },
  ] as const;

  it.each(cases)("validates $kind and rejects its bad boundary", ({ good, bad }) => {
    expect(coachActionSchema.safeParse(good).success).toBe(true);
    expect(coachActionSchema.safeParse(bad).success).toBe(false);
  });

  it.each(cases)("round-trips $kind from the flat wire form into the strict action", ({ good }) => {
    const parsed = coachActionWireSchema.safeParse(good);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(good);
  });

  it("exposes every action kind and keeps both provider schemas Gemini-safe", () => {
    expect([...ACTION_KINDS]).toEqual([
      "log_meal", "add_slot_item", "remove_slot_item", "set_slot_item", "move_slot",
      "add_to_avoid", "remove_from_avoid", "set_slot_meal", "delete_entry", "move_entry",
      "save_recipe", "shift_schedule", "log_water", "log_weight", "update_profile",
      "set_targets", "add_to_eats", "remove_from_eats", "add_to_shopping_list",
      "skip_slot", "restore_slot", "set_shopping_focus",
    ]);
    expect(() => assertSupported(flatCoachActionSchema)).not.toThrow();
    expect(() => assertSupported(providerActionSchema)).not.toThrow();
  });

  it("uses the migration ranges for profile fields", () => {
    for (const action of [
      { kind: "update_profile", heightCm: 49.9 },
      { kind: "update_profile", weightKg: 400.1 },
      { kind: "update_profile", birthYear: 1899 },
      { kind: "update_profile", bodyFatPct: 70.1 },
      { kind: "update_profile", trainingWeekdays: [7] },
    ]) expect(coachActionSchema.safeParse(action).success).toBe(false);
  });
});
