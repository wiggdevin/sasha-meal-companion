import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const name = "20261026090000_plan_days_eaten_slots";
const upPath = `supabase/migrations/${name}.sql`;
const downPath = `supabase/migrations/down/${name}.down.sql`;

describe(name, () => {
  it("adds validated eaten-slot tombstones and preserves omitted plan fields", () => {
    expect(existsSync(upPath)).toBe(true);
    const sql = readFileSync(upPath, "utf8");
    expect(sql).toContain("eaten_slots jsonb not null default '{}'::jsonb");
    expect(sql).toContain("plan_days_eaten_slots_shape");
    expect(sql).toContain("when p_payload ? 'eaten_slots'");
    for (const field of ["day_type_override", "floor_day", "swaps", "slot_notes", "item_overrides"]) {
      expect(sql).toContain(`when p_payload ? '${field}'`);
    }
  });

  it("has a reversible down migration", () => {
    expect(existsSync(downPath)).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql).toContain("drop column if exists eaten_slots");
    expect(sql).toContain("item_overrides = excluded.item_overrides");
  });
});
