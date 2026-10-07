// Step C (docs/plans/2026-09-22-tdee-engine-plan.md): static checks on the provenance migration,
// in the pattern of down-coverage.test.ts — read the real SQL and assert what a careless edit
// would get wrong.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const UP = readFileSync(path.join(root,
  "supabase/migrations/20261028090000_body_fat_provenance.sql"), "utf8");
const DOWN = readFileSync(path.join(root,
  "supabase/migrations/down/20261028090000_body_fat_provenance.down.sql"), "utf8");

describe("20261028090000_body_fat_provenance.sql", () => {
  it("adds two nullable columns with the six-source check and no backfill", () => {
    expect(UP).toContain("add column body_fat_source text constraint user_settings_body_fat_source_check");
    expect(UP).toContain("check (body_fat_source in");
    for (const source of ["dexa", "inbody", "clinical_bia", "consumer_scale", "visual_estimate",
      "typed_unknown"]) {
      expect(UP).toContain(`'${source}'`);
    }
    expect(UP).toContain("add column body_fat_measured_on date");
    expect(UP).not.toMatch(/not null|set default|update user_settings/i);
  });

  it("clears the provenance when the value changes without a new source, or is cleared", () => {
    expect(UP).toContain("if new.body_fat_pct is null then");
    expect(UP).toContain("elsif tg_op = 'UPDATE' then");
    expect(UP).toContain("new.body_fat_pct is distinct from old.body_fat_pct");
    expect(UP).toContain("new.body_fat_source is not distinct from old.body_fat_source");
    expect(UP).toContain("new.body_fat_measured_on is not distinct from old.body_fat_measured_on");
    expect(UP).toContain(
      "before insert or update of body_fat_pct, body_fat_source, body_fat_measured_on");
  });

  it("adds both keys to the sync contract with the omit/keep, present-null/clear rule", () => {
    expect(UP).toContain("does not occur exactly once");
    // Re-running is a no-op keyed on the first replacement, not on a bare column name.
    expect(UP).toContain("if position(replacements[1] in definition) > 0 then");
    expect(UP).not.toContain("position('body_fat_source' in definition)");
    expect(UP).toContain("case when p_payload ? ''body_fat_source''");
    expect(UP).toContain("else user_settings.body_fat_source end");
    expect(UP).toContain("case when p_payload ? ''body_fat_measured_on''");
    expect(UP).toContain("else user_settings.body_fat_measured_on end");
    expect(UP).toContain("revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) "
      + "from public, anon, authenticated;");
  });

  it("down restores the sync function first, then drops the trigger, function and columns", () => {
    const order = ["execute definition", "drop trigger if exists user_settings_body_fat_provenance",
      "drop function if exists user_settings_body_fat_provenance()",
      "drop column body_fat_measured_on, drop column body_fat_source"]
      .map((statement) => DOWN.indexOf(statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(DOWN).toContain("revoke execute on function _sync_upsert");
    expect(DOWN).toContain("does not occur exactly once");
  });
});
