/**
 * Phase A of docs/plans/2026-09-14-slot-item-editing.md — the column that lets an edited slot
 * survive a reload and reach her other device.
 *
 * `item_overrides` holds, per slot, the whole component list she ended up with. It is jsonb with a
 * '{}' default so every existing row reads as "nothing edited" without a backfill.
 *
 * The plan_days conflict clause stays last-writer-wins on purpose: plan_days is keyed by
 * (user_id, local_date), which IS the entity key, so apply_sync_op's base_rev CAS already refuses
 * a stale write. That is not true of duplicate_groups, which collides on a different arbiter —
 * which is why 20261016090000 needed its own rev guard and this does not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = read("supabase/migrations/20261017090000_plan_days_item_overrides.sql");
const DOWN = read("supabase/migrations/down/20261017090000_plan_days_item_overrides.down.sql");

describe("20261017090000_plan_days_item_overrides", () => {
  it("adds the column with a default, so existing rows need no backfill", () => {
    const sql = sqlOnly(UP);
    expect(sql).toContain("alter table plan_days");
    expect(sql).toContain("item_overrides");
    expect(sql).toMatch(/default '\{\}'::jsonb/);
  });

  it("writes the new field through _sync_upsert, defaulting to an empty object", () => {
    const sql = sqlOnly(UP);
    expect(sql).toContain("coalesce(p_payload->'item_overrides', '{}'::jsonb)");
    expect(sql).toContain("item_overrides = excluded.item_overrides");
  });

  it("keeps every plan_days field that was already synced", () => {
    const sql = sqlOnly(UP);
    for (const column of ["day_type_override", "floor_day", "swaps", "slot_notes"]) {
      expect(sql).toContain(`${column} = excluded.${column}`);
    }
  });

  it("carries forward the two guards added earlier the same day", () => {
    const sql = sqlOnly(UP);
    expect(sql).toContain("where duplicate_groups.rev < excluded.rev");
    expect(sql).toContain("where water_log.rev < excluded.rev");
  });

  it("down drops the column and says what that loses", () => {
    expect(sqlOnly(DOWN)).toContain("drop column");
    expect(sqlOnly(DOWN)).toContain("item_overrides");
    expect(DOWN).toMatch(/edit|override/i);
  });
});
