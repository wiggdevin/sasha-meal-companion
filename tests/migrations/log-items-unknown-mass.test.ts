// t17 gap 1: static checks on the unknown-mass migration. The real-database round trip (rolled
// back) is tests/log/unknown-mass-local-db.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const UP = readFileSync(path.join(root,
  "supabase/migrations/20261211090000_log_items_unknown_mass.sql"), "utf8");
const DOWN = readFileSync(path.join(root,
  "supabase/migrations/down/20261211090000_log_items_unknown_mass.down.sql"), "utf8");

describe("20261211090000_log_items_unknown_mass.sql", () => {
  it("drops NOT NULL on log_items.grams and keeps catalog items measured", () => {
    expect(UP).toContain("alter table public.log_items alter column grams drop not null;");
    expect(UP).toContain("check (grams is not null or (food_revision_id is null and portion_id is null))");
    expect(UP).not.toMatch(/update public\.log_items/i);
  });

  it("allows an unknown mass only on the account's own food, by trigger (round 3)", () => {
    expect(UP).toContain("r.id = new.food_ref_id and r.kind = 'user'");
    expect(UP).toContain("for each row when (new.grams is null)");
    expect(DOWN).toContain("drop trigger if exists log_items_unknown_mass_own_food on public.log_items;");
  });

  it("gives null grams an empty per-100 g snapshot and a per-unit snapshot from per_unit", () => {
    expect(UP).toContain("where id = p_food_ref_id and p_grams is not null");
    expect(UP).toContain("create or replace function public.compute_unit_snapshot(p_per_unit jsonb, p_qty numeric)");
    expect(UP).toContain("'basis', 'per_unit'");
    // Round 4: the exact per-unit number is kept, and a count edit recomputes from it.
    expect(UP).toContain("'per_unit', (kv.value)::numeric,");
    expect(UP).toContain("round((kv.value->>'per_unit')::numeric * p_qty, 4)");
    expect(UP).toContain("then recompute_unit_snapshot(v_prior->(i.id::text)->''snapshot'', i.qty)");
    expect(UP).not.toContain("scale_unit_snapshot");
    expect(DOWN).toContain("drop function if exists public.recompute_unit_snapshot(jsonb, numeric);");
    expect(UP).toContain("when jsonb_typeof(kv.value) = 'number' then (kv.value)::numeric >= 0 else false end");
  });

  it("patches _sync_upsert by anchors that must each occur once, idempotently, service-role only", () => {
    expect(UP.match(/does not occur exactly once/g)).toHaveLength(1);
    expect(UP).toContain("if position('compute_unit_snapshot' in definition) > 0 then return; end if;");
    expect(UP).toContain("confidence numeric, per_unit jsonb);");
    expect(UP).toContain("from public, anon, authenticated;");
  });

  it("down refuses while any mass is unknown, then restores the function and NOT NULL", () => {
    expect(DOWN).toContain("log_items holds items with an unknown mass");
    const order = ["drop function if exists public.compute_unit_snapshot",
      "drop constraint if exists log_items_unknown_mass_is_unit", "alter column grams set not null"]
      .map((statement) => DOWN.indexOf(statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
