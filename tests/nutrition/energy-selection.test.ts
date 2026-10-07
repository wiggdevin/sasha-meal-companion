/**
 * Calculation audit 2026-10-05, findings 17-19: the one per-item energy rule
 * (lib/nutrients/energy.ts) and the migration that mirrors it in SQL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { energyTotal, itemEnergy, itemKcal, sourceMix } from "@/lib/nutrients/energy";

const kcal = (amount: unknown) => ({ amount });

describe("itemEnergy", () => {
  it("prefers the reported amount when it is a finite number", () => {
    expect(itemEnergy({ energy_kcal: kcal(100), energy_kcal_calc: kcal(95) }))
      .toEqual({ kcal: 100, source: "reported" });
  });

  it("keeps a reported 0 as a measured zero, not a gap", () => {
    expect(itemEnergy({ energy_kcal: kcal(0), energy_kcal_calc: kcal(12) }))
      .toEqual({ kcal: 0, source: "reported" });
  });

  it("falls back to the calculated amount when the reported object exists with a null amount", () => {
    // The audit's probe: the old day-context test (object exists) returned 0 here.
    expect(itemEnergy({ energy_kcal: kcal(null), energy_kcal_calc: kcal(80) }))
      .toEqual({ kcal: 80, source: "calculated" });
  });

  it("falls back past non-finite, negative and non-number reported amounts", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "100", undefined]) {
      expect(itemEnergy({ energy_kcal: kcal(bad), energy_kcal_calc: kcal(80) }))
        .toEqual({ kcal: 80, source: "calculated" });
    }
  });

  it("is unknown (null), never 0, when neither field is usable", () => {
    expect(itemEnergy({ protein: kcal(5) })).toBeNull();
    expect(itemEnergy({ energy_kcal: kcal(null), energy_kcal_calc: kcal(null) })).toBeNull();
    expect(itemEnergy({})).toBeNull();
    expect(itemEnergy(null)).toBeNull();
    expect(itemKcal(undefined)).toBeNull();
  });
});

describe("energyTotal", () => {
  it("selects per item before it sums: 100 reported + 80 calculated is 180", () => {
    const total = energyTotal([
      { energy_kcal: kcal(100), energy_kcal_calc: kcal(95) },
      { energy_kcal: kcal(null), energy_kcal_calc: kcal(80) },
    ]);
    expect(total).toEqual({ kcal: 180, itemsWithValue: 2, itemsTotal: 2, coverage: 1,
      reportedItems: 1, calculatedItems: 1 });
  });

  it("counts an unknown item against coverage and adds nothing to the sum", () => {
    const total = energyTotal([{ energy_kcal_calc: kcal(80) }, { protein: kcal(5) }, {}]);
    expect(total).toMatchObject({ kcal: 80, itemsWithValue: 1, itemsTotal: 3, coverage: 0.3333 });
  });

  it("is null for a day with no usable energy, and 0 coverage for no items", () => {
    expect(energyTotal([{ protein: kcal(5) }]).kcal).toBeNull();
    expect(energyTotal([])).toMatchObject({ kcal: null, coverage: 0, itemsTotal: 0 });
  });

  it("names the source mix", () => {
    expect(sourceMix(1, 1)).toBe("mixed");
    expect(sourceMix(2, 0)).toBe("reported");
    expect(sourceMix(0, 3)).toBe("calculated");
    expect(sourceMix(0, 0)).toBeNull();
  });
});

describe("20261210090000_daily_energy.sql", () => {
  const root = process.cwd();
  const UP = readFileSync(path.join(root, "supabase/migrations/20261210090000_daily_energy.sql"),
    "utf8");
  const DOWN = readFileSync(path.join(root,
    "supabase/migrations/down/20261210090000_daily_energy.down.sql"), "utf8");

  it("selects reported, then calculated, per item, guarding the cast on the JSON type", () => {
    expect(UP).toContain("create or replace view public.daily_energy with (security_invoker = true)");
    expect(UP).toContain("jsonb_typeof(li.snapshot->'energy_kcal'->'amount') = 'number'");
    expect(UP).toContain("jsonb_typeof(li.snapshot->'energy_kcal_calc'->'amount') = 'number'");
    const reported = UP.indexOf("when v.reported >= 0 then v.reported");
    const calculated = UP.indexOf("when v.calculated >= 0 then v.calculated");
    expect(reported).toBeGreaterThan(0);
    expect(calculated).toBeGreaterThan(reported);
    expect(UP).toContain("where le.deleted_at is null");
    expect(UP).toContain("sum(kcal) as amount");
    expect(UP).toContain("count(kcal)::int as items_with_value");
  });

  it("keeps the privileged reader service-role only", () => {
    expect(UP).toContain("security definer set search_path = public, pg_temp");
    expect(UP).toContain(
      "revoke execute on function public.get_daily_energy(uuid, date) from public, authenticated, anon;");
    expect(UP).toContain("grant execute on function public.get_daily_energy(uuid, date) to service_role;");
  });

  it("down drops the function before the view", () => {
    const fn = DOWN.indexOf("drop function if exists public.get_daily_energy(uuid, date);");
    const view = DOWN.indexOf("drop view if exists public.daily_energy;");
    expect(fn).toBeGreaterThanOrEqual(0);
    expect(view).toBeGreaterThan(fn);
  });
});
