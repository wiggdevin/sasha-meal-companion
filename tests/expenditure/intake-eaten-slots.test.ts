// Audit 2026-10-10 A155: a ticked plan meal or an eaten recipe is not in `daily_energy`, so a day
// that holds one must never count at its logged part alone.
import { describe, expect, it } from "vitest";
import { eatenSlotIds, intakeDays } from "@/lib/server/expenditure-intake";
import { isQualifiedDay } from "@/lib/expenditure";

type Row = Record<string, unknown>;

function table(rows: Row[]) {
  const filters: ((row: Row) => boolean)[] = [];
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => { filters.push((r) => !(col in r) || r[col] === value); return builder; },
    gte: (col: string, value: string) => { filters.push((r) => String(r[col]) >= value); return builder; },
    lte: (col: string, value: string) => { filters.push((r) => String(r[col]) <= value); return builder; },
    in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return builder; },
    is: (col: string, value: unknown) => { filters.push((r) => (r[col] ?? null) === value); return builder; },
    order: () => builder,
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return builder;
}

const mark = (eatenAt: string | null) => ({ eaten_at: eatenAt, changed_at: "2026-09-10T12:00:00Z" });

function admin(planDays: Row[], logs: Row[]) {
  const energy = ["2026-09-08", "2026-09-09", "2026-09-10"].map((d) => ({
    local_date: d, amount: 1050, items_with_value: 3, items_total: 3, coverage: 1,
    reported_items: 3, calculated_items: 0 }));
  return { from: (name: string) => {
    if (name === "daily_energy") return table(energy);
    if (name === "plan_days") return table(planDays);
    if (name === "log_entries") return table(logs);
    throw new Error(`unexpected table ${name}`);
  } } as never;
}

describe("intakeDays with eaten plan slots (A155)", () => {
  it("drops a marked day whose ticked plan meals have no log under them", async () => {
    // Breakfast and lunch ticked from the plan (~1,200 kcal on Today), dinner logged (1,050 kcal),
    // and the day marked fully logged. The server can see only 1,050 kcal.
    const days = await intakeDays(admin([
      { local_date: "2026-09-09", day_complete_at: "2026-09-09T21:00:00Z",
        eaten_slots: { "meal-1": mark("2026-09-09T08:00:00Z"), "meal-2": mark("2026-09-09T12:00:00Z") } },
    ], [{ local_date: "2026-09-09", slot: "meal-3", deleted_at: null }]), "u1", "2026-09-01", "2026-09-11");
    expect(days.map((d) => d.date)).toEqual(["2026-09-08", "2026-09-10"]);
  });

  it("drops a coverage-complete day that holds an eaten recipe (no log entry)", async () => {
    // recipe_log_consumed ticks the slot eaten and stores the snapshot; it writes no log entry.
    const days = await intakeDays(admin([
      { local_date: "2026-09-10", day_complete_at: null,
        eaten_slots: { "meal-2": { ...mark("2026-09-10T12:00:00Z") } } },
    ], []), "u1", "2026-09-01", "2026-09-11");
    expect(days.map((d) => d.date)).toEqual(["2026-09-08", "2026-09-09"]);
    for (const day of days) expect(isQualifiedDay(day, "2026-09-11")).toBe(true);
  });

  it("keeps a day whose every eaten slot has a live log filed under it, and its mark", async () => {
    const days = await intakeDays(admin([
      { local_date: "2026-09-09", day_complete_at: "2026-09-09T21:00:00Z",
        eaten_slots: { "meal-1": mark("2026-09-09T08:00:00Z"), "meal-2": mark(null) } },
    ], [{ local_date: "2026-09-09", slot: "meal-1", deleted_at: null }]), "u1", "2026-09-01", "2026-09-11");
    expect(days).toHaveLength(3);
    expect(days.find((d) => d.date === "2026-09-09")).toMatchObject({ kcal: 1050, userMarkedComplete: true });
  });

  it("does not count a deleted log as the slot's record", async () => {
    const days = await intakeDays(admin([
      { local_date: "2026-09-09", day_complete_at: null,
        eaten_slots: { "meal-1": mark("2026-09-09T08:00:00Z") } },
    ], [{ local_date: "2026-09-09", slot: "meal-1", deleted_at: "2026-09-09T09:00:00Z" }]),
    "u1", "2026-09-01", "2026-09-11");
    expect(days.map((d) => d.date)).not.toContain("2026-09-09");
  });

  it("reads only non-null eaten_at marks as eaten", () => {
    expect(eatenSlotIds({ "meal-1": mark("2026-09-09T08:00:00Z"), "meal-2": mark(null) })).toEqual(["meal-1"]);
    expect(eatenSlotIds(null)).toEqual([]);
    expect(eatenSlotIds([])).toEqual([]);
  });
});
