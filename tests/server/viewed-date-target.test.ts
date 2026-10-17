/**
 * The Plan sheet sizes suggestions for the day it shows, not for the server's today. PlanSheet
 * sends `now: new Date(`${date}T12:00:00`)`; accountClock turns that into the turn's date, and
 * every slot target is read from that date's plan, logs and day type (training or rest).
 */
import { describe, expect, it, vi } from "vitest";
import { accountClock, buildDayContext } from "@/lib/server/day-context";
import { suggestionTarget } from "@/lib/server/coach-ports";
import type { CoachTurnRequest } from "@/lib/coach/types";
import { MONDAY, REVISION_ROW, seeded, withTargets } from "../coach/context-fixtures";

const TZ = "America/Denver";
/** REVISION_ROW trains on Mon/Wed/Fri; the 15th is a Tuesday, a rest day. */
const TUESDAY = "2026-09-15";
const SERVER_NOW = Date.parse("2026-10-03T18:00:00.000Z");

function planSheetTurn(date: string): CoachTurnRequest {
  return { threadId: null, messageId: "m1", text: "Suggest three meal options",
    surface: "plan", now: new Date(`${date}T12:00:00-06:00`).toISOString(), tz: TZ } as never;
}

describe("the Plan sheet's viewed date", () => {
  it("is the turn's date, whatever the server clock says", () => {
    expect(accountClock(planSheetTurn(TUESDAY), SERVER_NOW).date).toBe(TUESDAY);
    expect(accountClock(planSheetTurn(MONDAY), SERVER_NOW).date).toBe(MONDAY);
  });

  it("decides the day type and so the day's target", async () => {
    const monday = withTargets(await buildDayContext(seeded(), "u1", MONDAY, TZ));
    const tuesday = withTargets(await buildDayContext(seeded(), "u1", TUESDAY, TZ));
    expect(monday.dayType).not.toBe("rest");
    expect(monday.targets.kcal).toBe(2200);
    expect(tuesday.dayType).toBe("rest");
    expect(tuesday.targets.kcal).toBe(1800);
  });

  it("sizes a suggestion from that date's own planning share", async () => {
    const admin = seeded();
    const clock = accountClock(planSheetTurn(TUESDAY), SERVER_NOW);
    const day = withTargets(await buildDayContext(admin, "u1", TUESDAY, TZ, "meal-3"));
    const target = await suggestionTarget(admin, "u1",
      { kind: "meal", count: 3, slot: "meal-3", fitRemaining: true }, clock);
    expect(day.planningTarget).toBeDefined();
    expect(target!.kcal).toBeCloseTo(Math.min(day.planningTarget!.kcal, day.remaining.kcal), 5);
    // The rest-day revision, not the training day the server's own clock might pick.
    expect(target!.kcal).toBeLessThan(1800);
  });

  it("re-plans a meal that is already planned into the share the sheet shows", async () => {
    const admin = seeded({ plan_days: [{ day_type_override: null, floor_day: false, swaps: {},
      slot_notes: {}, eaten_slots: {}, item_overrides: { "meal-1": {
        baseMealId: null, title: "Whey protein shake", components: [{ name: "whey", qty: 62,
          unit: "g", role: "free", macros: { kcal: 544, protein: 55, carbs: 33, fat: 21 } }] } } }],
    log_entries: [] });
    const day = withTargets(await buildDayContext(admin, "u1", TUESDAY, TZ, "meal-1"));
    const meals = day.slots.filter((slot) => slot.slot.startsWith("meal-")).length;
    expect(day.planningTarget!.kcal).toBeCloseTo(1800 / meals, 5);
    const target = await suggestionTarget(admin, "u1",
      { kind: "meal", count: 3, slot: "meal-1", fitRemaining: true }, { tz: TZ, date: TUESDAY });
    expect(target!.kcal).toBeCloseTo(1800 / meals, 5);
  });

  it("counts a log outside the slots once, so the shares add up to what is left", async () => {
    // seeded(): Meal 1 eaten (280 kcal saved meal) and a 198 kcal log filed under Meal 2.
    const day = withTargets(await buildDayContext(seeded(), "u1", TUESDAY, TZ, "meal-3"));
    const open = day.slots.filter((slot) => slot.slot.startsWith("meal-") && slot.state !== "eaten");
    expect(day.planningTarget!.kcal * open.length).toBeCloseTo(day.remaining.kcal, 0);
  });
});

// Audit A167: the server's UTC date is still the day before for an Auckland morning. A revision
// dated the account's today must still give that day its own meal count and slot clocks.
describe("the viewed date's revision, east of UTC", () => {
  it("keeps the revision's 4-meal layout while the server's UTC date is the day before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-10T20:00:00.000Z")); // 09:00 Oct 11 in Auckland
      const admin = seeded({ target_profiles: [{ ...REVISION_ROW, effective_from: "2026-10-11" }],
        plan_days: [], log_entries: [] });
      const day = withTargets(await buildDayContext(admin, "u1", "2026-10-11", "Pacific/Auckland"));
      const meals = day.slots.filter((slot) => slot.slot.startsWith("meal-"));
      // REVISION_ROW trains at 2200 kcal: four meals, the last at 18:30.
      expect(meals.map((slot) => slot.slot)).toEqual(["meal-1", "meal-2", "meal-3", "meal-4"]);
      expect(meals.map((slot) => slot.time)).toEqual(["08:00", "11:30", "15:00", "18:30"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
