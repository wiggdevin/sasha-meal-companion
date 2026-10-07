/**
 * T6 finding 3: the exported `goal` has to agree with Today, including a date she locked as a
 * rest or training day (T5's `plan_days.day_type_override`). The helper is pure, so most of this
 * is a plain unit test; the last case drives `streamWater` through a PostgREST double to prove the
 * overrides are actually loaded for the exported dates and reach the row.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/server/export.ts imports "server-only"; the marker package is stubbed, never the module.
vi.mock("server-only", () => ({}));

const { dayTypeOverrides, waterGoalsFor } = await import("@/lib/server/export-water");
const { streamWater } = await import("@/lib/server/export");

/**
 * `training_weekdays` is named explicitly: there is no weekday template any more (D1 §6.3), so an
 * account that named no training day trains on none and every date would export the rest goal.
 * Monday makes 2026-09-14 a training day.
 */
const SETTINGS = { water_goal_cups: 10, water_goal_cups_training: 12, water_goal_cups_rest: 9,
  training_weekdays: [1] };

describe("exported water goals", () => {
  it("keeps the weekday goal when no date is locked", () => {
    const goals = waterGoalsFor(SETTINGS, dayTypeOverrides([]));
    // 2026-09-15 is a Tuesday (rest), 2026-09-14 a Monday (training).
    expect(goals.forDate("2026-09-15")).toBe(9);
    expect(goals.forDate("2026-09-14")).toBe(12);
    expect(goals.goal_training_cups).toBe(12);
    expect(goals.goal_rest_cups).toBe(9);
  });

  it("follows a locked day type on the date it was locked", () => {
    const overrides = dayTypeOverrides([
      { local_date: "2026-09-15", day_type_override: "training-10" },
      { local_date: "2026-09-14", day_type_override: "rest" },
      { local_date: "2026-09-16", day_type_override: null },
    ]);
    const goals = waterGoalsFor(SETTINGS, overrides);
    expect(goals.forDate("2026-09-15")).toBe(12);   // Tuesday, locked as a training day
    expect(goals.forDate("2026-09-14")).toBe(9);    // Monday, locked as a rest day
    expect(goals.forDate("2026-09-16")).toBe(9);    // Wednesday, no lock — not a training weekday
    expect(overrides.has("2026-09-16")).toBe(false);
  });

  it("falls back to the legacy goal, then to 8, when the split columns are absent", () => {
    const overrides = dayTypeOverrides([]);
    expect(waterGoalsFor({ water_goal_cups: 11 }, overrides).forDate("2026-09-15")).toBe(11);
    expect(waterGoalsFor({}, overrides).forDate("2026-09-15")).toBe(8);
    expect(waterGoalsFor(null, overrides).goal_training_cups).toBe(8);
  });
});

type TableRows = Record<string, Record<string, unknown>[]>;
type Filter = { column: string; value: unknown };

/**
 * A PostgREST double for the two shapes `streamWater` uses: a filtered `.maybeSingle()` for
 * user_settings, and an awaited builder for water_log and plan_days. Every `.in()` call is
 * recorded, so a test can assert which dates the override lookup asked for.
 */
function fakeClient(tables: TableRows) {
  const eq: Record<string, Filter> = {};
  const inCalls: { table: string; column: string; values: unknown[] }[] = [];
  const matching = (table: string, filter?: Filter) => (tables[table] ?? [])
    .filter((row) => !filter || String(row[filter.column]) === String(filter.value));
  const builder = (table: string) => {
    const q = {
      select: () => q,
      eq(column: string, value: unknown) { eq[table] = { column, value }; return q; },
      gte: () => q, lte: () => q, gt: () => q,
      in(column: string, values: unknown[]) {
        inCalls.push({ table, column, values: [...values] });
        return Promise.resolve({ data: matching(table), error: null });
      },
      order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: matching(table, eq[table])[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: matching(table, eq[table]), error: null }).then(resolve),
    };
    return q;
  };
  return { client: { from: (table: string) => builder(table) } as unknown as SupabaseClient,
    inCalls };
}

describe("streamWater", () => {
  it("reports the locked day's goal, and both day-type goals, on every row", async () => {
    const { client, inCalls } = fakeClient({
      user_settings: [{ user_id: "u1", ...SETTINGS }],
      water_log: [
        { user_id: "u1", local_date: "2026-09-14", cups: 4 },
        { user_id: "u1", local_date: "2026-09-15", cups: 6 },
      ],
      plan_days: [
        { user_id: "u1", local_date: "2026-09-15", day_type_override: "training-10" },
      ],
    });
    const page = await streamWater(client, "u1", { limit: 50 });
    // Only the dates on this page are looked up, and the lock is what moves the Tuesday row.
    expect(inCalls).toEqual([{ table: "plan_days", column: "local_date",
      values: ["2026-09-14", "2026-09-15"] }]);
    expect(page.rows).toEqual([
      { local_date: "2026-09-14", cups: 4, goal: 12, goal_training_cups: 12, goal_rest_cups: 9 },
      { local_date: "2026-09-15", cups: 6, goal: 12, goal_training_cups: 12, goal_rest_cups: 9 },
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it("uses the rest goal for a Monday locked as a rest day and a plain Tuesday", async () => {
    const { client } = fakeClient({
      user_settings: [{ user_id: "u1", ...SETTINGS }],
      water_log: [
        { user_id: "u1", local_date: "2026-09-14", cups: 3 },
        { user_id: "u1", local_date: "2026-09-15", cups: 3 },
      ],
      plan_days: [
        { user_id: "u1", local_date: "2026-09-14", day_type_override: "rest" },
      ],
    });
    const page = await streamWater(client, "u1", { limit: 50 });
    expect(page.rows.map((r) => r.goal)).toEqual([9, 9]);
  });
});
