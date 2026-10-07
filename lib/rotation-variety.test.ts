import { describe, it, expect } from "vitest";
import { mealsForDay, rotationIndex } from "./rotation";
describe("ingredient repetition", () => {
  it("no ingredient appears 3+ times in one day, over 60 days", () => {
    const bad: string[] = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 8, 8 + i)).toISOString().slice(0, 10);
      const names = mealsForDay(d).flatMap(({ meal }) =>
        meal.components.filter(c => c.role !== "free").map(c => c.name)
      );
      const counts = new Map<string, number>();
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
      const dupes = [...counts.entries()].filter(([, n]) => n >= 3).map(([n, c]) => `${n}x${c}`);
      if (dupes.length) bad.push(`${d}: ${dupes.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("rotation phase offsets", () => {
  it("meal slots do not all advance in lockstep", () => {
    // The bug this guards: every slot shared one index, so meal-1/2/3 moved
    // together and repeatedly landed on options sharing an ingredient.
    const idx = (slot: "meal-1" | "meal-2" | "meal-3") =>
      rotationIndex("2026-09-08", 6, slot);
    const all = [idx("meal-1"), idx("meal-2"), idx("meal-3")];
    expect(new Set(all).size).toBe(3);
  });

  it("is still deterministic — same date and slot always give the same index", () => {
    expect(rotationIndex("2026-09-08", 6, "meal-2")).toBe(
      rotationIndex("2026-09-08", 6, "meal-2"),
    );
  });
});
