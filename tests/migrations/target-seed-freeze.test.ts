// TDEE step E1: static checks on the seed-freeze migration, in the pattern of rate-goals.test.ts.
// The round trip on a real database is tests/targets/seed-freeze-db.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const UP = readFileSync(path.join(root,
  "supabase/migrations/20261209090000_target_seed_freeze.sql"), "utf8");
const DOWN = readFileSync(path.join(root,
  "supabase/migrations/down/20261209090000_target_seed_freeze.down.sql"), "utf8");
const COLUMNS = ["initial_tdee_kcal", "bmr_kcal", "bmr_method", "activity_model_version",
  "derivation_version"];

describe("20261209090000_target_seed_freeze.sql", () => {
  it("adds five nullable columns and backfills nothing", () => {
    for (const column of COLUMNS) expect(UP).toMatch(new RegExp(`add column ${column} (integer|text)`));
    expect(UP).not.toMatch(/not null/i);
    expect(UP).not.toMatch(/update (public\.)?target_profiles/i);
    expect(UP).toContain("check (bmr_method in ('mifflin', 'katch'))");
  });

  it("leaves the rate-goals marker text intact, so re-running that migration stays a no-op", () => {
    // 20261029090000 returns early when it finds this exact text; a patch that rewrote it made
    // tests/tenancy/pr241-production-order.test.ts fail with "anchor 1 does not occur exactly once".
    expect(UP).toContain("    initial_tdee_kcal, bmr_kcal, bmr_method, activity_model_version, "
      + "derivation_version,\n    input_activity_level, input_goal, formula_name, kcal_min_source)");
  });

  it("copies the active seed forward on approval and restates the grants", () => {
    for (const column of COLUMNS) expect(UP).toContain(`''${column}'', v_active.${column}`);
    for (const fn of ["write_target_revision(uuid, jsonb)", "approve_target_proposal(uuid, uuid)"]) {
      expect(UP).toContain(`grant execute on function ${fn} to authenticated, service_role`);
      expect(DOWN).toContain(`grant execute on function ${fn} to authenticated, service_role`);
    }
    expect(UP.match(/does not occur exactly once/g)).toHaveLength(2);
  });

  it("down refuses to drop frozen seeds without consent, restores functions, then drops columns", () => {
    expect(DOWN).toContain("app.allow_down_data_loss");
    const order = ["execute definition", "execute replace(definition, added, '')",
      "drop column derivation_version"].map((statement) => DOWN.indexOf(statement));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
