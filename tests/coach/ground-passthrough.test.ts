import { describe, expect, it, vi } from "vitest";
import { groundActions, type CoachActionInput } from "@/lib/coach/actions";
import { groundAndExpandActions } from "@/lib/coach/ground";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";

const REF = (suffix: string) => `3f1b1a2c-0000-4000-8000-0000000000${suffix}`;

describe("T4 action grounding", () => {
  it("passes the five non-food families through without searching", async () => {
    const searchFoods = vi.fn();
    const inputs: CoachActionInput[] = [
      { kind: "shift_schedule", date: "2026-09-19", minutes: 30, scope: "remaining" },
      { kind: "log_water", date: "2026-09-19", ml: 480 },
      { kind: "log_weight", date: "2026-09-19", kg: 58.1 },
      { kind: "update_profile", birthYear: 1992 },
      { kind: "set_targets", dayType: "training", kcal: 2300 },
    ];

    const result = await groundActions("u1", inputs, DEFAULT_PROFILE, {
      searchFoods,
      newActionId: () => "action-id",
    });

    expect(result.clarifications).toEqual([]);
    expect(result.actions).toEqual(inputs.map((input) => ({
      ...input, actionId: "action-id", flagged: [],
    })));
    expect(searchFoods).not.toHaveBeenCalled();
  });

  it("grounds add_to_eats and widens it to every same-name ref", async () => {
    const searchFoods = vi.fn(async () => [{
      foodRefId: REF("11"), name: "Watermelon, raw", brand: null,
      catalogFoodRevisionId: 7, kcalPer100g: 30, proteinPer100g: 0.6,
      carbsPer100g: 7.6, fatPer100g: 0.2, prefStatus: "avoid" as const,
    }]);
    const sameNameRefIds = vi.fn(async () => [REF("11"), REF("12"), REF("13")]);

    const result = await groundActions("u1", [{ kind: "add_to_eats", name: "watermelon" }],
      DEFAULT_PROFILE, { searchFoods, sameNameRefIds, newActionId: () => "action-id" });

    expect(result.clarifications).toEqual([]);
    expect(result.actions[0]).toMatchObject({
      kind: "add_to_eats", name: "Watermelon, raw", foodRefId: REF("11"),
      alsoFoodRefIds: [REF("12"), REF("13")],
    });
    expect(sameNameRefIds).toHaveBeenCalledWith("u1", "Watermelon, raw");
  });

  it("treats remove_from_eats as the add_to_avoid alias when the food is blocked", async () => {
    const searchFoods = vi.fn(async () => [{
      foodRefId: REF("11"), name: "Watermelon, raw", brand: null,
      catalogFoodRevisionId: 7, kcalPer100g: 30, proteinPer100g: 0.6,
      carbsPer100g: 7.6, fatPer100g: 0.2, prefStatus: "avoid" as const,
    }]);

    const result = await groundActions("u1", [{ kind: "remove_from_eats", name: "watermelon" }],
      DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.actions[0]).toMatchObject({ kind: "remove_from_eats", flagged: [] });
  });
});

describe("PRD §2.3 multi-day meal expansion", () => {
  const searchFoods = vi.fn(async () => [{
    foodRefId: REF("21"), name: "Eggs", brand: null,
    catalogFoodRevisionId: 7, kcalPer100g: 143, proteinPer100g: 13,
    carbsPer100g: 0.7, fatPer100g: 9.5, prefStatus: "eats" as const,
  }]);
  const base = {
    kind: "set_slot_meal" as const, from: "2026-09-20", slot: "meal-1" as const,
    title: "Eggs", items: [{ name: "eggs", grams: 200 }],
  };

  it("grounds a 31-date series once and emits one action", async () => {
    searchFoods.mockClear();
    const result = await groundAndExpandActions("u1", [{
      ...base, through: "2026-10-20",
    }], DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.clarifications).toEqual([]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      kind: "set_slot_meal", from: "2026-09-20", through: "2026-10-20",
      dates: expect.arrayContaining(["2026-09-20", "2026-10-20"]),
    });
    expect(result.actions[0].kind === "set_slot_meal" && result.actions[0].dates)
      .toHaveLength(31);
    expect(searchFoods).toHaveBeenCalledOnce();
  });

  it("rejects a 32-day span before applying a weekday filter and states why", async () => {
    const result = await groundAndExpandActions("u1", [{
      ...base, through: "2026-10-21", weekdays: [1],
    }], DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.actions).toEqual([]);
    expect(result.clarifications).toEqual([
      "I can plan at most 31 calendar days at once. Shorten the range and try again.",
    ]);
  });

  it("filters weekdays after expanding the inclusive two-week range", async () => {
    const result = await groundAndExpandActions("u1", [{
      ...base, through: "2026-10-03", weekdays: [1, 2, 3, 4, 5],
    }], DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.actions[0].kind === "set_slot_meal" && result.actions[0].dates).toEqual([
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
    ]);
  });

  it("keeps civil calendar days intact across a DST boundary", async () => {
    const result = await groundAndExpandActions("u1", [{
      ...base, from: "2026-10-31", through: "2026-11-02",
    }], DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.actions[0].kind === "set_slot_meal" && result.actions[0].dates)
      .toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("keeps calendar dates intact across a year boundary", async () => {
    const result = await groundAndExpandActions("u1", [{
      ...base, from: "2026-12-31", through: "2027-01-02",
    }], DEFAULT_PROFILE, { searchFoods, newActionId: () => "action-id" });

    expect(result.actions[0].kind === "set_slot_meal" && result.actions[0].dates)
      .toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});
