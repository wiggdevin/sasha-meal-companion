/**
 * O4 review round 4, BLOCK 2: the viewed day the coach builds suggestions on carries the account's
 * saved slot times and whole-day shift (`user_settings.slot_times`, `shift_minutes`), so
 * `suggest_options` reads a saved 09:30 meal-2 as breakfast, not the layout's 12:30 lunch.
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ ports: null as null | Record<string, unknown> }));
vi.mock("@/lib/coach/suggest", () => ({
  suggestOptions: vi.fn(async (_input: unknown, ports: Record<string, unknown>) => {
    captured.ports = ports;
    return [];
  }),
}));

import { defaultPorts } from "@/lib/server/coach-ports";
import { buildDayContext } from "@/lib/server/day-context";
import { occasionAt } from "@/lib/meals/occasion";
import { scheduleFieldsFromRow } from "@/lib/plan-schedule";
import { resolveSlotTimes } from "@/lib/plan";
import { slotClocksFor } from "@/lib/shopping/coverage";
import { seeded } from "../coach/context-fixtures";

const TUESDAY = "2026-09-15";
const TZ = "America/Denver";
const settings = (row: Record<string, unknown>) => seeded({ user_settings: [{ meals_per_day: 3, ...row }] });
const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] } as never;

async function slotClockFor(row: Record<string, unknown>, slot: string) {
  const admin = settings(row);
  const ports = defaultPorts(admin, admin, () => "id", { tz: TZ, date: TUESDAY,
    now: `${TUESDAY}T18:00:00.000Z` }, { profile });
  captured.ports = null;
  await ports.suggest("u1", { kind: "meal", count: 3, slot: slot as never });
  return captured.ports!.slotClock as (id: string) => Promise<string | null>;
}

describe("the viewed day reads the saved schedule", () => {
  it("maps saved slot times and the whole-day shift", async () => {
    const saved = await buildDayContext(settings({ slot_times: { "meal-2": "09:30" } }), "u1", TUESDAY, TZ);
    expect(saved.slots.find((row) => row.slot === "meal-2")?.time).toBe("09:30");
    const shifted = await buildDayContext(settings({ shift_minutes: 60 }), "u1", TUESDAY, TZ);
    expect(shifted.slots.find((row) => row.slot === "meal-3")?.time).toBe("19:30");
  });

  it("gives suggest_options the saved slot's clock, so a 09:30 meal-2 is breakfast", async () => {
    const slotClock = await slotClockFor({ slot_times: { "meal-2": "09:30" } }, "meal-2");
    expect(await slotClock("meal-2")).toBe("09:30");
    expect(occasionAt(await slotClock("meal-2"))).toBe("breakfast");
  });

  it("answers no clock for a slot the schedule does not have", async () => {
    const slotClock = await slotClockFor({}, "meal-6");
    expect(await slotClock("meal-6")).toBeNull();
  });

  it("applies a large saved shift exactly as Today does (review round 1 BLOCK 4)", async () => {
    // meal-1 at 09:15 shifted by 780 minutes: Today says 22:15, overnight ("other").
    const row = { slot_times: { "meal-1": "09:15" }, shift_minutes: 780 };
    const today = resolveSlotTimes("rest", { mealsPerDay: 3, slotTimes: { "meal-1": "09:15" },
      shiftMinutes: 780 }).find((slot) => slot.slot === "meal-1")?.time;
    expect(today).toBe("22:15");
    expect(scheduleFieldsFromRow(row).shiftMinutes).toBe(780);
    const planner = slotClocksFor({ mealCount: 3, ...scheduleFieldsFromRow(row) })
      .find((slot) => slot.slotId === "meal-1");
    expect(planner).toMatchObject({ time: today, occasion: occasionAt(today) });
    expect(planner?.occasion).toBe("other");
    const viewed = await buildDayContext(settings(row), "u1", TUESDAY, TZ);
    expect(viewed.slots.find((slot) => slot.slot === "meal-1")?.time).toBe(today);
    // A shift past the end of the day stops at 23:59 on both sides, never wraps.
    expect(slotClocksFor({ mealCount: 3, ...scheduleFieldsFromRow({ shift_minutes: 1500 }) })[0].time)
      .toBe(resolveSlotTimes("rest", { mealsPerDay: 3, slotTimes: {}, shiftMinutes: 1500 })[0].time);
  });

  it("drops malformed values instead of guessing", () => {
    expect(scheduleFieldsFromRow({ slot_times: { "meal-1": "7am", "meal-2": "09:30", "meal-3": 5 },
      shift_minutes: "x" })).toEqual({ slotTimes: { "meal-2": "09:30" }, shiftMinutes: 0 });
    expect(scheduleFieldsFromRow(null)).toEqual({ slotTimes: {}, shiftMinutes: 0 });
  });
});
