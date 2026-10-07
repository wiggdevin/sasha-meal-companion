import { describe, expect, it } from "vitest";
import { toDayContext } from "@/lib/server/day-context";
import { buildSystemPrompt } from "@/lib/coach/prompt";
import type { ResolvedDay } from "@/lib/types";

describe("meals streak P2", () => {
  it("tells the coach to report a stored plan title exactly", () => {
    const prompt = buildSystemPrompt({
      today: "2026-09-20",
      constraints: {
        avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
        conditions: [], notes: null,
      },
    });

    expect(prompt).toContain("lead with that exact dish title");
  });

  it("gives get_plan the stored dish title for a future slot", () => {
    const macros = { kcal: 604, protein: 40.5, carbs: 41.7, fat: 29 };
    const day = {
      date: "2026-10-05",
      dayType: "rest",
      rampStage: 3,
      isFloorDay: false,
      targets: { kcal: 2_000, protein: 120, carbs: 220, fat: 70 },
      slots: [{
        slot: "meal-1",
        time: "09:00",
        label: "Breakfast",
        meal: {
          id: "breakfast",
          name: "Sourdough toast, bacon & eggs",
          slot: "meal-1",
          components: [],
          macros,
          prepMinutes: 10,
          tags: [],
        },
        components: [],
        macros,
        eaten: false,
      }],
      extras: [],
      consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
      waterCups: 0,
    } as ResolvedDay;

    expect(toDayContext(day, "America/Denver", []).slots[0]).toMatchObject({
      slot: "meal-1",
      label: "Breakfast",
      title: "Sourdough toast, bacon & eggs",
    });
  });
});
