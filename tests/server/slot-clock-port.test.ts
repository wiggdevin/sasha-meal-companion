/**
 * The suggestion build may ask for a named slot's planned clock time on the viewed date
 * (`slotClock`, lib/coach/meal-type.ts). A Plan-sheet turn's own clock is noon of that date, so
 * the slot's time, not the turn's, says whether Meal 1 is breakfast.
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
import { seeded } from "../coach/context-fixtures";

const TUESDAY = "2026-09-15";
const TZ = "America/Denver";

describe("slotClock", () => {
  it("reads the named slot's planned time on the viewed date", async () => {
    const admin = seeded();
    const profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] } as never;
    const ports = defaultPorts(admin, admin, () => "id", { tz: TZ, date: TUESDAY,
      now: `${TUESDAY}T18:00:00.000Z` }, { profile });
    await ports.suggest("u1", { kind: "meal", count: 3, slot: "meal-1" });
    const slotClock = captured.ports!.slotClock as (slot: string) => Promise<string | null>;
    const day = await buildDayContext(admin, "u1", TUESDAY, TZ);
    const meal1 = day.slots.find((row) => row.slot === "meal-1")!.time;
    expect(await slotClock("meal-1")).toBe(meal1);
    expect(await slotClock("meal-6")).toBeNull();
  });
});
