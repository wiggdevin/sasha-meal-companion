import { describe, expect, it } from "vitest";
import { projectPulledEntry } from "@/lib/log/pulled-entry";
import { entryMacros } from "@/lib/resolve";
import type { LoggedFood, StoredDay } from "@/lib/types";

const SNAP = { energy_kcal: { amount: 200, unit: "kcal" }, protein: { amount: 20, unit: "g" },
  carbohydrate: { amount: 10, unit: "g" }, fat_total: { amount: 5, unit: "g" } };

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1", local_date: "2026-10-10", eaten_at: "2026-10-10T12:00:00.000Z", slot: "meal-2",
    title: "Tuna bowl", note: "from the tablet", rev: 2, deleted_at: null,
    items: [{ id: "i1", seq: 1, food_ref_id: "ref-1", grams: 150, qty: 150, unit: "g", snapshot: SNAP }],
    ...over,
  };
}

function card(over: Partial<LoggedFood> = {}): LoggedFood {
  return {
    id: "e1", foodId: "meal", name: "My bowl", slot: "meal-2", portionLabel: "1 item", qty: 1,
    grams: 150, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, rev: 1, at: "2026-10-10T12:00:00.000Z",
    items: [{ id: "i1", seq: 1, food_ref_id: "ref-1", grams: 150, qty: 150, unit: "g", snapshot: {},
      foodId: "catalog:1", name: "Tuna", portionLabel: "150 g", macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 } }],
    ...over,
  };
}

const day = (date: string, extras: LoggedFood[]): StoredDay => ({ date, extras } as StoredDay);

describe("projectPulledEntry", () => {
  it("puts another device's new entry on Today, counted from its snapshots", () => {
    const days = projectPulledEntry({}, "e1", row());
    const shown = days["2026-10-10"]?.extras?.[0];
    expect(shown?.name).toBe("Tuna bowl");
    expect(shown?.note).toBe("from the tablet");
    expect(shown?.rev).toBe(2);
    expect(entryMacros(shown!).kcal).toBeGreaterThan(0);
  });

  it("brings an older card up to the pulled revision and keeps the card's own food names", () => {
    const days = projectPulledEntry({ "2026-10-10": day("2026-10-10", [card()]) }, "e1", row());
    const shown = days["2026-10-10"]?.extras?.[0];
    expect(shown?.rev).toBe(2);
    expect(shown?.note).toBe("from the tablet");
    expect(shown?.items?.[0]?.name).toBe("Tuna");
  });

  it("never moves a card backwards", () => {
    const days = { "2026-10-10": day("2026-10-10", [card({ rev: 5, note: "newer here" })]) };
    expect(projectPulledEntry(days, "e1", row({ rev: 3 }))).toBe(days);
  });

  it("moves the card when another device moved the entry to another date", () => {
    const days = projectPulledEntry({ "2026-10-09": day("2026-10-09", [card()]) }, "e1",
      row({ local_date: "2026-10-10" }));
    expect(days["2026-10-09"]?.extras).toEqual([]);
    expect(days["2026-10-10"]?.extras?.map((e) => e.id)).toEqual(["e1"]);
  });

  it("leaves the days alone for a deleted row or a row with no date", () => {
    const days = { "2026-10-10": day("2026-10-10", [card()]) };
    expect(projectPulledEntry(days, "e1", row({ deleted_at: "2026-10-10T13:00:00Z" }))).toBe(days);
    expect(projectPulledEntry(days, "e1", row({ local_date: null }))).toBe(days);
  });
});
