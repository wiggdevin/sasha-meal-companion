// Recipe and shopping previews size a slot from the day's authoritative target. A meal already
// eaten elsewhere that day (a recipe snapshot) must reserve what was actually eaten, the same way
// the Today screen does (lib/resolve.ts slotTarget), instead of the even split.
import { describe, expect, it } from "vitest";
import { authoritativeSlotTarget } from "@/lib/recipes/slot-target";

const DATE = "2026-10-03";
const profile = {
  id: "target-1", rev: 3, input_training_weekdays: [] as number[],
  training_macros: { kcal: 2400, protein: 150, carbs: 280, fat: 70 },
  rest_macros: { kcal: 2100, protein: 150, carbs: 240, fat: 60 },
};

const snapshot = (kcal: number) => ({
  baseMealId: "recipe:overnight-oats", title: "Overnight oats",
  components: [{ name: "Overnight oats", qty: 1, unit: "serving", role: "carb",
    macros: { kcal, protein: 30, carbs: 120, fat: 20 } }],
});

describe("authoritativeSlotTarget", () => {
  it("splits the day evenly when nothing is eaten or edited", () => {
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", null)?.kcal).toBeCloseTo(700, 5);
  });

  it("reserves an eaten recipe snapshot in another slot before sizing this one", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: "2026-10-03T08:00:00Z",
      changed_at: "2026-10-03T08:00:00Z", consumed: snapshot(900) } } };
    const aimed = authoritativeSlotTarget(profile, DATE, 3, "meal-2", row);
    expect(aimed?.kcal).toBeCloseTo((2100 - 900) / 2, 5);
    expect(aimed?.protein).toBeCloseTo((150 - 30) / 2, 5);
  });

  it("keeps the even split for a plain eaten tick with no recipe snapshot", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: "2026-10-03T08:00:00Z",
      changed_at: "2026-10-03T08:00:00Z" } } };
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", row)?.kcal).toBeCloseTo(700, 5);
  });

  it("ignores an un-eaten mark (eaten_at null) even if it still carries a snapshot", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: null,
      changed_at: "2026-10-03T08:00:00Z", consumed: snapshot(900) } } };
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", row)?.kcal).toBeCloseTo(700, 5);
  });

  it("treats a malformed snapshot as a plain tick rather than trusting its numbers", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: "2026-10-03T08:00:00Z",
      changed_at: "2026-10-03T08:00:00Z", consumed: { baseMealId: 7, components: "x" } } } };
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", row as never)?.kcal)
      .toBeCloseTo(700, 5);
  });

  it("still lets the previewed slot replace its own saved edit", () => {
    const row = { item_overrides: { "meal-2": { followPlan: false, baseMealId: "x",
      components: [{ name: "Toast", qty: 1, unit: "slice", role: "carb",
        macros: { kcal: 100, protein: 3, carbs: 18, fat: 1 } }] } } };
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", row as never)?.kcal)
      .toBeCloseTo(700, 5);
  });

  // 2026-10-04 audit (MAJOR 3): the day's logs were never passed in, so a recipe aimed at a slot
  // ignored 800 kcal already logged and double-booked them.
  const entry = (id: string, kcal: number, slot?: "meal-1" | "meal-3" | "snack") => ({
    id, foodId: "meal", name: "Logged", qty: 1, grams: 200, portionLabel: "Logged",
    macros: { kcal, protein: 20, carbs: 60, fat: 10 }, at: "2026-10-03T10:00:00Z", ...(slot ? { slot } : {}),
  });

  it("subtracts the day's logged food, with an eaten snapshot, before sizing the slot", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: "2026-10-03T08:00:00Z",
      changed_at: "2026-10-03T08:00:00Z", consumed: snapshot(900) } } };
    const aimed = authoritativeSlotTarget(profile, DATE, 3, "meal-2", row, [entry("e1", 800, "snack")]);
    // Two open slots share 2100 - 900 - 800; the aimed slot fits inside the target less both.
    expect(aimed?.kcal).toBeCloseTo((2100 - 900 - 800) / 2, 5);
    expect(aimed!.kcal).toBeLessThanOrEqual(2100 - 900 - 800);
    expect(aimed?.protein).toBeCloseTo((150 - 30 - 20) / 2, 5);
  });

  it("counts a log filed under an eaten slot with no snapshot once, as that meal", () => {
    const row = { eaten_slots: { "meal-1": { eaten_at: "2026-10-03T08:00:00Z",
      changed_at: "2026-10-03T08:00:00Z" } } };
    expect(authoritativeSlotTarget(profile, DATE, 3, "meal-2", row, [entry("e1", 500, "meal-1")])?.kcal)
      .toBeCloseTo((2100 - 500) / 2, 5);
  });
});
