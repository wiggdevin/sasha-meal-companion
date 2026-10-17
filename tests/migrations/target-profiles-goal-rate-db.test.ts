/**
 * W074: the preset CHECK on target_profiles.goal_rate_bp_week. Static checks run in every unit
 * shard; the database half runs the two files inside one transaction on the local stack and rolls
 * it back. Production is applied by the owner, with a backup, one file at a time.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (t: string) => t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const NAMES = ["20270104100000_target_profiles_goal_rate_check",
  "20270104100100_target_profiles_goal_rate_check_validate"];
const up = (name: string) => read(`supabase/migrations/${name}.sql`);
const down = (name: string) => read(`supabase/migrations/down/${name}.down.sql`);
const PRESETS = "check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25))";

describe("target_profiles goal rate check migrations (static)", () => {
  it("are live-safe: timeouts, NOT VALID first, VALIDATE in the follow-up", () => {
    for (const name of NAMES) {
      expect(up(name)).toContain("set local lock_timeout = '3s';");
      expect(up(name)).toMatch(/set local statement_timeout = '(30|120)s';/);
    }
    const first = sqlOnly(up(NAMES[0]));
    expect(first).toContain(PRESETS);
    expect(first).toContain("not valid;");
    expect(first).not.toMatch(/validate constraint|\bupdate\b/i);
    const second = sqlOnly(up(NAMES[1]));
    expect(second).toContain("validate constraint target_profiles_goal_rate_bp_week_check;");
    expect(second).not.toMatch(/\bupdate public\.|\bdelete from\b/i);
  });

  it("uses the same preset set as user_settings and the app", () => {
    expect(read("supabase/migrations/20261029090000_rate_goals.sql"))
      .toContain("check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25))");
  });

  it("has a down file for each", () => {
    for (const name of NAMES) expect(down(name).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("target_profiles goal rate check (database, rolled back)", () => {
  const owner = "00000000-0000-4000-8000-0000000007a4";
  const seed = [
    "begin;",
    `insert into auth.users (id, email) values ('${owner}', 'w074-migration@meal-companion.test');`,
  ];
  const row = (date: string, rate: number) =>
    "insert into public.target_profiles (user_id, effective_from, kcal_train, kcal_rest, authored_by, mode,"
    + " protein_g, fat_g, carb_g, protein_g_min, goal_rate_bp_week) values "
    + `('${owner}', '${date}', 2200, 2000, 'user', 'grams', 150, 60, 200, 100, ${rate});`;

  it("an off-preset insert fails; a preset insert and an existing row still read", () => {
    const base = [...seed, down(NAMES[1]), down(NAMES[0]), row("2026-01-01", 0)];
    const out = runSql([...base, up(NAMES[0]), up(NAMES[1]), row("2026-01-02", -50),
      "select 'rows:' || count(*) from public.target_profiles where user_id = '" + owner + "';",
      "rollback;"].join("\n"));
    expect(out).toContain("rows:2");
    expect(runSql([...base, up(NAMES[0]), up(NAMES[1]),
      "select 'old:' || goal_rate_bp_week from public.target_profiles where effective_from = '2026-01-01';",
      "rollback;"].join("\n"))).toContain("old:0");
    expect(() => runSql([...base, up(NAMES[0]), up(NAMES[1]), row("2026-01-03", -30), "rollback;"].join("\n")))
      .toThrow(/target_profiles_goal_rate_bp_week_check/);
  });

  it("the NOT VALID file alone already rejects a new off-preset insert and keeps old rows", () => {
    expect(() => runSql([...seed, down(NAMES[1]), down(NAMES[0]), row("2026-01-01", -30), up(NAMES[0]),
      row("2026-01-02", -30), "rollback;"].join("\n"))).toThrow(/target_profiles_goal_rate_bp_week_check/);
    expect(runSql([...seed, down(NAMES[1]), down(NAMES[0]), row("2026-01-01", -30), up(NAMES[0]),
      "select 'kept:' || count(*) from public.target_profiles where user_id = '" + owner + "';",
      "rollback;"].join("\n"))).toContain("kept:1");
  });

  it("validation names the problem when a legacy row holds another rate", () => {
    expect(() => runSql([...seed, down(NAMES[1]), down(NAMES[0]), row("2026-01-01", -30),
      up(NAMES[0]), up(NAMES[1]), "rollback;"].join("\n")))
      .toThrow(/outside the presets/);
  });
});
