/** Phase 19 §5.2 / §7: the one missed rule, `isMissedSlot`. */
import { describe, expect, it } from "vitest";
import { clearMeal } from "@/lib/today/meal-actions";
import type { StoredDay } from "@/lib/types";
import {
  account, at, build, DATE, eatenAt, entry, item, saved, slotOf,
} from "./__fixtures__/days";
import { clockToMinutes, dayHasActivity, isMissedSlot, MISSED_GRACE_MINUTES } from "./missed";

function day(stored: Omit<StoredDay, "date">, date = DATE) {
  const store = account();
  store.days[date] = { date, ...stored };
  return build(store, date);
}

const breakfastEaten = { eaten: eatenAt("meal-1"), itemOverrides: { "meal-1": saved(500, "Oats") } };

describe("isMissedSlot", () => {
  it("is missed at exactly slot time + 90 min, not at + 89", () => {
    const { day: resolved, slots } = day(breakfastEaten);
    const lunch = slotOf(slots, "meal-2");
    expect(lunch.time).toBe("12:30");
    expect(MISSED_GRACE_MINUTES).toBe(90);
    expect(isMissedSlot(lunch, resolved, at("13:59"))).toBe(false);
    expect(isMissedSlot(lunch, resolved, at("14:00"))).toBe(true);
    expect(isMissedSlot(lunch, resolved, at("12:31"), 0)).toBe(true);
  });

  it("is never missed on a day with no activity", () => {
    const { day: resolved, slots } = day({ itemOverrides: { "meal-1": saved(500) } });
    expect(dayHasActivity(resolved)).toBe(false);
    expect(slots.some((slot) => isMissedSlot(slot, resolved, at("23:59")))).toBe(false);
  });

  it("is missed once one slot is eaten, or one entry is logged", () => {
    const eaten = day(breakfastEaten);
    expect(isMissedSlot(slotOf(eaten.slots, "meal-2"), eaten.day, at("15:00"))).toBe(true);
    const snack = day({ extras: [entry("snack", [item({ reported: 150 })], "snack")] });
    expect(isMissedSlot(slotOf(snack.slots, "meal-1"), snack.day, at("10:00"))).toBe(true);
  });

  it("counts a floor day, a gut entry or a weight as activity", () => {
    for (const stored of [{ floorDay: true }, { gut: "good" as const }, { weightLb: 150 }]) {
      const { day: resolved, slots } = day(stored);
      expect(dayHasActivity(resolved)).toBe(true);
      expect(isMissedSlot(slotOf(slots, "meal-1"), resolved, at("10:00"))).toBe(true);
    }
  });

  it("misses every uneaten, uncleared slot of a past active day unless a log is filed under it", () => {
    const past = "2026-10-05";
    const { day: resolved, slots } = day({ ...breakfastEaten,
      itemOverrides: { ...breakfastEaten.itemOverrides, "meal-3": clearMeal(undefined, null) },
      extras: [entry("lunch", [item({ reported: 400 })], "meal-2")] }, past);
    const now = at("07:00"); // today, early: the past day is missed whatever the clock says
    expect(slots.map((slot) => [slot.slot, isMissedSlot(slot, resolved, now)])).toEqual([
      ["meal-1", false], // eaten
      ["meal-2", false], // food logged under it
      ["meal-3", false], // cleared
    ]);
    const open = day({ ...breakfastEaten }, past);
    expect(open.slots.filter((slot) => isMissedSlot(slot, open.day, now)).map((slot) => slot.slot))
      .toEqual(["meal-2", "meal-3"]);
  });

  it("never misses a slot on a future date", () => {
    const { day: resolved, slots } = day(breakfastEaten, "2026-10-07");
    expect(slots.some((slot) => isMissedSlot(slot, resolved, at("23:59")))).toBe(false);
  });

  it("keeps an unplanned empty slot eligible and never misses an explicit Clear", () => {
    const { day: resolved, slots } = day({ eaten: eatenAt("meal-3"),
      itemOverrides: { "meal-3": saved(600), "meal-1": clearMeal(undefined, null) } });
    const [cleared, empty] = [slotOf(slots, "meal-1"), slotOf(slots, "meal-2")];
    expect(cleared.meal).toBeNull();
    expect(empty.meal).toBeNull();
    expect(isMissedSlot(cleared, resolved, at("23:00"))).toBe(false);
    expect(isMissedSlot(empty, resolved, at("23:00"))).toBe(true);
  });

  it("reads a clock as minutes after midnight", () => {
    expect(clockToMinutes("00:00")).toBe(0);
    expect(clockToMinutes("21:30")).toBe(1290);
  });
});
