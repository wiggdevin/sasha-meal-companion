import { describe, expect, it } from "vitest";
import { consumedRecipeSnapshotSchema, eatenSlotsSchema } from "@/lib/sync/plan-days-schema";

const consumed = { baseMealId: "recipe:revision-1", title: "Stew", components: [{
  name: "Stew", qty: 0.25, unit: "whole", role: "free",
  macros: { kcal: 83.2, protein: 5.5, carbs: 9, fat: 2 },
}] };
const mark = { "meal-3": { eaten_at: "2026-09-15T12:00:00Z",
  changed_at: "2026-09-15T12:00:00Z", consumed } };

describe("consumed recipe mark", () => {
  it("accepts a complete quarter-serving snapshot and legacy marks", () => {
    expect(eatenSlotsSchema.safeParse(mark).success).toBe(true);
    expect(eatenSlotsSchema.safeParse({ "meal-3": { eaten_at: null,
      changed_at: "2026-09-15T13:00:00Z" } }).success).toBe(true);
    expect(eatenSlotsSchema.safeParse({ "meal-3": { eaten_at: null,
      changed_at: "2026-09-15T13:00:00Z",
      history_epoch: "11111111-1111-4111-8111-111111111111" } }).success).toBe(true);
  });
  it("rejects missing, forged, unbounded, or tombstoned nutrients", () => {
    expect(consumedRecipeSnapshotSchema.safeParse({ ...consumed, components: [{
      ...consumed.components[0], macros: { kcal: 83.2, protein: 5.5, fat: 2 },
    }] }).success).toBe(false);
    expect(consumedRecipeSnapshotSchema.safeParse({ ...consumed, components: [{
      ...consumed.components[0], macros: { ...consumed.components[0].macros, kcal: Infinity },
    }] }).success).toBe(false);
    expect(consumedRecipeSnapshotSchema.safeParse({ ...consumed, components: [{
      ...consumed.components[0], qty: 21,
    }] }).success).toBe(false);
    expect(eatenSlotsSchema.safeParse({ "meal-3": { ...mark["meal-3"], eaten_at: null } }).success).toBe(false);
    expect(eatenSlotsSchema.safeParse({ "meal-3": { ...mark["meal-3"],
      history_epoch: "not-a-uuid" } }).success).toBe(false);
  });
});
