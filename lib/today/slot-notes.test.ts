import { describe, expect, it } from "vitest";
import { proteinShortfall, slotNote, type GeneratedNotes } from "./slot-notes";
import type { Meal, ResolvedSlot, StoredDay } from "@/lib/types";

const ZERO = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const empty: ResolvedSlot = {
  slot: "meal-1", time: "07:30", label: "Meal 1", meal: null, components: [], macros: ZERO, eaten: false,
};
const meal: Meal = { id: "plate", name: "Plate", slot: "meal-2", prepMinutes: 0, tags: [], components: [], macros: ZERO };
const planned: ResolvedSlot = { ...empty, slot: "meal-2", meal };
const notes: GeneratedNotes = {
  proteins: { available: 2, required: 3 },
  shortages: { "meal-1": { missing: ["starch"], reason: "No breakfast starch or fruit fits yet — try another food" } },
  misses: { "meal-2": "These foods can’t reach this meal’s protein in usual portions" },
};

describe("slotNote", () => {
  it("gives an empty slot its shortage and a generated plate its miss", () => {
    expect(slotNote(empty, undefined, notes)).toEqual({
      emptyReason: "No breakfast starch or fruit fits yet — try another food", planMiss: null });
    expect(slotNote(planned, undefined, notes)).toEqual({
      emptyReason: null, planMiss: "These foods can’t reach this meal’s protein in usual portions" });
  });

  it("keeps a time-only edit on the generated plate", () => {
    const day: StoredDay = { date: "2026-10-05", itemOverrides: { "meal-2": { baseMealId: null, components: [], followPlan: true, time: "13:00" } } };
    expect(slotNote(planned, day, notes).planMiss).not.toBeNull();
  });

  it("says nothing about a slot the person edited, cleared or ticked, or without a run", () => {
    const edited: StoredDay = { date: "2026-10-05", itemOverrides: { "meal-2": { baseMealId: null, components: [] } } };
    const cleared: StoredDay = { date: "2026-10-05", itemOverrides: { "meal-1": { baseMealId: null, components: [], cleared: true } } };
    const none = { emptyReason: null, planMiss: null };
    expect(slotNote(planned, edited, notes)).toEqual(none);
    expect(slotNote(empty, cleared, notes)).toEqual(none);
    expect(slotNote({ ...planned, eaten: true }, undefined, notes)).toEqual(none);
    expect(slotNote(empty, undefined, null)).toEqual(none);
  });
});

describe("proteinShortfall", () => {
  it("shows only when a slot has no protein at all", () => {
    expect(proteinShortfall(notes)).toEqual({ available: 2, required: 3 });
    expect(proteinShortfall({ ...notes, proteins: { available: 2, required: 2 } })).toBeNull();
    expect(proteinShortfall(null)).toBeNull();
  });
});
