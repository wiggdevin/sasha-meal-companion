import { describe, expect, it } from "vitest";
import { componentMinutes, plateMinutes, UNKNOWN_MINUTES } from "@/lib/plan/prep-minutes";

describe("prep minutes (curated component table)", () => {
  it.each([
    ["Greek yogurt, plain, nonfat", 1], ["Banana", 1], ["Almonds", 0], ["Olive oil", 0],
    ["Bread, whole wheat", 3], ["Tuna, canned in water", 2], ["Eggs, whole, cooked", 8],
    ["Oats, rolled", 5], ["Broccoli, steamed", 7], ["Tofu, firm", 10], ["Salmon, Atlantic", 12],
    ["Chicken breast, roasted", 20], ["Rice, white, cooked", 20], ["Instant rice", 3],
    ["Sweet potato, baked", 25],
  ])("%s → %i min", (name, minutes) => {
    expect(componentMinutes({ name })).toBe(minutes);
  });

  it("an unknown name never passes a 15-minute cut", () => {
    expect(componentMinutes({ name: "Mystery casserole" })).toBe(UNKNOWN_MINUTES);
  });

  it("a food marked no-cook is ready", () => {
    expect(componentMinutes({ name: "Chicken breast", noCook: true })).toBe(0);
  });

  it("a plate is its longest component plus 2 per other component that needs work", () => {
    expect(plateMinutes([{ name: "Eggs" }, { name: "Bread" }, { name: "Banana" }])).toBe(10);
    expect(plateMinutes([{ name: "Greek yogurt" }, { name: "Blueberries" }])).toBe(1);
  });
});
