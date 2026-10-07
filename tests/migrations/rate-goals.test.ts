// Step D (docs/plans/2026-09-22-tdee-engine-plan.md §D): static checks on the rate-goals
// migration, in the pattern of body-fat-provenance.test.ts — read the real SQL and assert what a
// careless edit would get wrong.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const UP = readFileSync(path.join(root,
  "supabase/migrations/20261029090000_rate_goals.sql"), "utf8");
const DOWN = readFileSync(path.join(root,
  "supabase/migrations/down/20261029090000_rate_goals.down.sql"), "utf8");

describe("20261029090000_rate_goals.sql", () => {
  it("adds a nullable rate to user_settings limited to the seven presets, with no backfill", () => {
    expect(UP).toContain("add column goal_rate_bp_week integer constraint "
      + "user_settings_goal_rate_bp_week_check");
    expect(UP).toContain("check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25))");
    expect(UP).not.toMatch(/update user_settings/i);
  });

  it("labels every existing revision's minimum as the legacy default, never as an account floor", () => {
    expect(UP).toContain("add column kcal_min_source text not null default 'legacy_default'");
    expect(UP).toContain("check (kcal_min_source in ('macro_minimum', 'account_minimum', "
      + "'legacy_default'))");
    expect(UP).not.toMatch(/update target_profiles/i);
    expect(UP).toContain("never a medical limit");
  });

  it("adds the rate to the sync contract with the omit/keep, present-null/clear rule", () => {
    expect(UP).toContain("case when p_payload ? ''goal_rate_bp_week''");
    expect(UP).toContain("else user_settings.goal_rate_bp_week end");
    expect(UP).toContain("(p_payload->>''goal_rate_bp_week'')::integer, p_rev)");
    expect(UP).toContain("revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) "
      + "from public, anon, authenticated;");
  });

  it("writes kcal_min_source through write_target_revision, defaulting to the legacy label", () => {
    expect(UP).toContain("input_activity_level, input_goal, formula_name, kcal_min_source)");
    expect(UP).toContain("coalesce(p_row->>''kcal_min_source'', ''legacy_default''))");
    expect(UP).toContain("revoke execute on function write_target_revision(uuid, jsonb)");
    expect(UP).toContain("grant execute on function write_target_revision(uuid, jsonb) "
      + "to authenticated, service_role");
  });

  it("makes an approved proposal record its trend weight as 'trend' and carry the minimum source", () => {
    expect(UP).toContain("then null else ''trend'' end,");
    expect(UP).toContain("''kcal_min_source'', coalesce(v_active.kcal_min_source, "
      + "''legacy_default''),");
    expect(UP).toContain("revoke execute on function approve_target_proposal(uuid, uuid)");
    expect(UP).toContain("grant execute on function approve_target_proposal(uuid, uuid) "
      + "to authenticated, service_role");
  });

  it("patches each function by anchors that must occur exactly once, and re-runs as a no-op", () => {
    expect(UP.match(/does not occur exactly once/g)).toHaveLength(3);
    expect(UP.match(/if position\(replacements\[1\] in definition\) > 0 then/g)).toHaveLength(3);
  });

  it("down restores the three functions first, then drops both columns", () => {
    const order = ["execute definition", "drop column kcal_min_source",
      "drop column goal_rate_bp_week"].map((statement) => DOWN.indexOf(statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(DOWN.match(/does not occur exactly once/g)).toHaveLength(3);
    for (const fn of ["_sync_upsert", "write_target_revision", "approve_target_proposal"]) {
      expect(DOWN).toContain(`revoke execute on function ${fn}`);
    }
    for (const fn of ["write_target_revision(uuid, jsonb)", "approve_target_proposal(uuid, uuid)"]) {
      expect(DOWN).toContain(`grant execute on function ${fn} to authenticated, service_role`);
    }
  });
});
