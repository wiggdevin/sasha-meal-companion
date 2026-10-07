import { describe, expect, it } from "vitest";
import { entryMinutes, mergeTimeline, slotMinutes } from "@/lib/today-timeline";
import type { LoggedFood, Macros, ResolvedSlot } from "@/lib/types";

const NO_MACROS: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

function slot(id: string, time: string): ResolvedSlot {
  return {
    slot: id as ResolvedSlot["slot"],
    time,
    label: id,
    meal: { id, name: id, components: [] } as unknown as ResolvedSlot["meal"],
    components: [],
    macros: NO_MACROS,
    eaten: false,
  };
}

/** `at` is built from local parts on purpose: the stack is ordered by her wall clock. */
function extra(id: string, hour: number, minute = 0): LoggedFood {
  return {
    id,
    foodId: "f",
    name: id,
    portionLabel: "serving",
    qty: 1,
    grams: 100,
    macros: NO_MACROS,
    at: new Date(2026, 8, 15, hour, minute).toISOString(),
  };
}

describe("slotMinutes", () => {
  it("reads a 24h slot time", () => {
    expect(slotMinutes("08:30")).toBe(510);
    expect(slotMinutes("00:00")).toBe(0);
  });

  it("falls back to midnight for an unreadable time", () => {
    expect(slotMinutes("")).toBe(0);
    expect(slotMinutes("nonsense")).toBe(0);
  });
});

describe("entryMinutes", () => {
  it("reads an ISO timestamp in local time", () => {
    expect(entryMinutes(new Date(2026, 8, 15, 15, 10).toISOString())).toBe(910);
  });

  it("returns null rather than a number for an unparseable timestamp", () => {
    expect(entryMinutes("not a date")).toBeNull();
  });
});

describe("mergeTimeline", () => {
  it("slots a logged snack between the plan meals either side of it", () => {
    const merged = mergeTimeline(
      [slot("meal-1", "12:30"), slot("meal-2", "18:00")],
      [extra("snack", 15, 10)],
    );
    expect(merged.map((i) => i.key)).toEqual(["slot-meal-1", "extra-snack", "slot-meal-2"]);
  });

  it("keeps the plan in clock order when nothing was logged", () => {
    const merged = mergeTimeline([slot("coffee", "08:00"), slot("meal-1", "12:30")], []);
    expect(merged.map((i) => i.key)).toEqual(["slot-coffee", "slot-meal-1"]);
  });

  it("puts the plan slot first when a logged entry lands on the same minute", () => {
    const merged = mergeTimeline([slot("meal-1", "12:30")], [extra("bite", 12, 30)]);
    expect(merged.map((i) => i.key)).toEqual(["slot-meal-1", "extra-bite"]);
  });

  it("sends an unreadable timestamp to the end, never to midnight", () => {
    const broken = { ...extra("broken", 9), at: "not a date" };
    const merged = mergeTimeline([slot("coffee", "08:00")], [broken]);
    expect(merged.map((i) => i.key)).toEqual(["slot-coffee", "extra-broken"]);
  });

  it("holds the logged order for two entries at the same minute", () => {
    const merged = mergeTimeline([], [extra("first", 15), extra("second", 15)]);
    expect(merged.map((i) => i.key)).toEqual(["extra-first", "extra-second"]);
  });

  it("carries every slot and every extra through exactly once", () => {
    const merged = mergeTimeline(
      [slot("coffee", "08:00"), slot("meal-1", "12:30")],
      [extra("a", 9), extra("b", 20)],
    );
    expect(merged).toHaveLength(4);
    expect(merged.filter((i) => i.kind === "extra")).toHaveLength(2);
  });
});
