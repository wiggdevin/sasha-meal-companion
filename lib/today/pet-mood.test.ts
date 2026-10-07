import { describe, expect, it } from "vitest";
import { expectedShare, petState } from "@/lib/today/pet-mood";

const targets = { kcal: 2000, protein: 150, carbs: 200, fat: 70 };
const day = (kcal: number, protein: number, cups?: number, extra: Partial<{ partial: boolean }> = {}) => ({
  targets, consumed: { kcal, protein, carbs: 0, fat: 0 }, water: cups === undefined ? undefined : { cups, goal: 8 },
  ...extra,
});

describe("Sprout's mood", () => {
  it("expects nothing in the morning and the whole day by evening", () => {
    expect(expectedShare(9)).toBe(0);
    expect(expectedShare(20)).toBe(1);
  });

  it("starts the morning happy, before anything is due", () => {
    expect(petState(day(0, 0, 0), 8).mood).toBe("joyful");
  });

  it("thrives when calories, protein and water keep pace with the hour", () => {
    expect(petState(day(1100, 80, 4), 14.5).mood).toBe("joyful");
  });

  it("is a little low when the day falls well behind in the afternoon, and says so without a prompt", () => {
    const state = petState(day(200, 10, 1), 17);
    expect(state.mood).toBe("droopy");
    expect(state.line).not.toMatch(/log|eat|meal|need/i);
  });

  it("never calls a young day low", () => {
    expect(petState(day(0, 0, 0), 12).mood).not.toBe("droopy");
  });

  it("never calls a partly measured day low", () => {
    expect(petState(day(200, 10, 1, { partial: true }), 18).mood).toBe("content");
  });

  it("leaves a partly measured day's short totals out of the meter instead of scoring a lower bound", () => {
    expect(petState(day(200, 10, 1, { partial: true }), 18).vitality).toBe(0.15);
    expect(petState(day(200, 10, undefined, { partial: true }), 18).vitality).toBeNull();
    expect(petState(day(2000, 150, undefined, { partial: true }), 20).vitality).toBe(1);
  });

  it("is never low on a day that has reached its calories, even with protein and water behind", () => {
    expect(petState(day(2100, 10, 1), 19).mood).toBe("content");
  });

  it("never thrives, and is never low, on a day well over its calories", () => {
    const state = petState(day(2600, 20, 0), 19);
    expect(state.mood).toBe("content");
  });

  it("leaves out what it does not know instead of scoring it", () => {
    const noWater = petState(day(2000, 150), 20);
    expect(noWater.vitality).toBe(1);
    const noTargets = petState({ targets: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, consumed: targets }, 15);
    expect(noTargets.vitality).toBeNull();
    expect(noTargets.mood).toBe("content");
  });

  it("sleeps at night whatever the day", () => {
    expect(petState(day(2000, 150, 8), 22).mood).toBe("sleepy");
    expect(petState(day(0, 0, 0), 3).mood).toBe("sleepy");
  });

  it("judges a past day whole, awake, and a future day not at all", () => {
    expect(petState(day(2000, 150, 8), 23, "past")).toMatchObject({ mood: "joyful", line: "A well cared-for day." });
    expect(petState(day(300, 20, 1), 23, "past").mood).toBe("droopy");
    expect(petState(day(0, 0, 0), 10, "future")).toMatchObject({ mood: "content", vitality: null });
  });

  it("keeps vitality between 0 and 1", () => {
    for (const hour of [6, 9, 12, 15, 18, 21]) {
      const { vitality } = petState(day(5000, 400, 20), hour);
      expect(vitality).toBeGreaterThanOrEqual(0);
      expect(vitality).toBeLessThanOrEqual(1);
    }
  });
});
