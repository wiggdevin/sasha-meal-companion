/**
 * U6 (D3, F2): additive validation for the six profile fields introduced by
 * 20261022090000_profile_targets.sql. The live behavior is covered by the branch-backed profile
 * sync integration suite; this file keeps the migration and its rollback reviewable in CI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const sqlOnly = (text: string) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const UP = sqlOnly(read("supabase/migrations/20261023090200_profile_checks.sql"));
const DOWN = sqlOnly(read("supabase/migrations/down/20261023090200_profile_checks.down.sql"));

describe("20261023090200_profile_checks", () => {
  it("requires unique training weekdays whose values are all between zero and six", () => {
    expect(UP).toContain("constraint user_settings_training_weekdays_valid_check");
    expect(UP).toContain("training_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]");
    expect(UP).toContain("cardinality(training_weekdays)");
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      expect(UP).toContain(`case when ${day} = any(training_weekdays) then 1 else 0 end`);
    }
  });

  it("requires every non-null diet preference value to be a JSON object", () => {
    expect(UP).toContain("constraint user_settings_diet_prefs_object_check");
    expect(UP).toContain("diet_prefs is null or jsonb_typeof(diet_prefs) = 'object'");
  });

  it("validates both additive checks after adding them without an initial table scan", () => {
    expect(UP.match(/not valid;/g)).toHaveLength(2);
    expect(UP).toContain("validate constraint user_settings_training_weekdays_valid_check");
    expect(UP).toContain("validate constraint user_settings_diet_prefs_object_check");
  });

  it("down drops only the two checks added by this migration", () => {
    expect(DOWN).toContain("drop constraint if exists user_settings_training_weekdays_valid_check");
    expect(DOWN).toContain("drop constraint if exists user_settings_diet_prefs_object_check");
    expect(DOWN).not.toMatch(/drop\s+(column|table)/i);
  });
});
