/**
 * Phase A wiring: an edited slot has to reach the Today screen AND MCP `get_day`, because
 * `resolveDay` is what both read (F-042's acceptance says they must agree about the same date).
 *
 * The ruling is recalculate-and-show-the-difference. So the assertions here are: the override's
 * components are what the slot holds, the slot's macros are their sum, and NOTHING else on that
 * card or anywhere else in the day is resized because of it.
 */
import { describe, expect, it } from "vitest";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings } from "@/lib/store";
import type { FoodComponent, Store, StoredDay } from "@/lib/types";

const MONDAY = "2026-09-07"; // training-10

const wholeMilk: FoodComponent = {
  name: "Whole milk", qty: 1, unit: "cup", role: "free",
  macros: { kcal: 168, protein: 8, carbs: 12, fat: 9 },
};

function storeWith(day?: Partial<StoredDay>): Store {
  return {
    version: 1,
    firstOpenedAt: "2026-08-01T12:00:00.000Z",
    settings: defaultSettings(),
    days: day ? { [MONDAY]: { date: MONDAY, ...day } } : {},
    foods: {},
  };
}

const slotOf = (store: Store, slot: string) =>
  resolveDay(store, MONDAY).slots.find((s) => s.slot === slot);

describe("an edited slot", () => {
  it("uses the override title as the meal name", () => {
    const edited = slotOf(storeWith({ itemOverrides: { coffee: {
      baseMealId: "coffee-latte", components: [wholeMilk], title: "Vanilla latte",
    } } }), "coffee");
    expect(edited?.meal?.name).toBe("Vanilla latte");
  });

  it("materializes what was recorded on an otherwise empty slot", () => {
    const base = slotOf(storeWith(), "coffee");
    expect(base).toBeUndefined();

    const edited = slotOf(
      storeWith({ itemOverrides: { coffee: { baseMealId: null, components: [wholeMilk] } } }),
      "coffee");
    expect(edited?.components).toEqual([wholeMilk]);
  });

  it("recalculates that slot's macros from what is on it", () => {
    const edited = slotOf(
      storeWith({ itemOverrides: { coffee: { baseMealId: "coffee-latte", components: [wholeMilk] } } }),
      "coffee");
    expect(edited?.macros).toEqual({ kcal: 168, protein: 8, carbs: 12, fat: 9 });
  });

  it("does not resize any other slot in the day", () => {
    const before = resolveDay(storeWith(), MONDAY);
    const after = resolveDay(
      storeWith({ itemOverrides: { coffee: { baseMealId: "coffee-latte", components: [wholeMilk] } } }),
      MONDAY);

    for (const slot of before.slots) {
      if (slot.slot === "coffee") continue;
      const same = after.slots.find((s) => s.slot === slot.slot);
      expect(same?.components).toEqual(slot.components);
      expect(same?.macros).toEqual(slot.macros);
    }
  });

  it("keeps the day's targets untouched — logging does not move plan numbers", () => {
    const before = resolveDay(storeWith(), MONDAY);
    const after = resolveDay(
      storeWith({ itemOverrides: { coffee: { baseMealId: "coffee-latte", components: [wholeMilk] } } }),
      MONDAY);
    expect(after.targets).toEqual(before.targets);
  });

  it("leaves an unedited slot alone", () => {
    const edited = slotOf(
      storeWith({ itemOverrides: { coffee: { baseMealId: "coffee-latte", components: [wholeMilk] } } }),
      "meal-1");
    const planned = slotOf(storeWith(), "meal-1");
    expect(edited?.components).toEqual(planned?.components);
  });

  it("treats a cleared slot as empty, not as unedited", () => {
    const cleared = slotOf(
      storeWith({ itemOverrides: { coffee: { baseMealId: "coffee-latte", components: [] } } }),
      "coffee");
    expect(cleared?.components).toEqual([]);
    expect(cleared?.macros).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  });

  it("keeps an explicitly cleared added slot empty", () => {
    const cleared = slotOf(storeWith({ itemOverrides: { "meal-4": {
      baseMealId: null, components: [], added: true, cleared: true,
    } } }), "meal-4");
    expect(cleared?.meal).toBeNull();
    expect(cleared?.components).toEqual([]);
  });
});
