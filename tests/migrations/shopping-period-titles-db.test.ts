/**
 * UI makeover W7 (supabase/migrations/20270107090200_shopping_period_titles.sql and
 * 20270107090300_shopping_period_titles_validate.sql) on a real Postgres. Needs
 * SUPABASE_TEST_DB_URL (a local stack); skipped without it. Every case runs inside one transaction
 * that is rolled back, so the stack is left as it was.
 *
 * - The up file adds a nullable `title`: null and a trimmed 1-60 character title insert; a blank,
 *   padded or 61-character title is refused by the check.
 * - The validate file validates that check.
 * - The down file removes the column and its check, and refuses while a list carries a title
 *   unless app.allow_down_data_loss = on.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const UP = readFileSync("supabase/migrations/20270107090200_shopping_period_titles.sql", "utf8");
const VALIDATE = readFileSync("supabase/migrations/20270107090300_shopping_period_titles_validate.sql", "utf8");
const DOWN = readFileSync("supabase/migrations/down/20270107090200_shopping_period_titles.down.sql", "utf8");
const VALIDATE_DOWN = readFileSync(
  "supabase/migrations/down/20270107090300_shopping_period_titles_validate.down.sql", "utf8");
const A = "a0000000-0000-4000-8000-0000000007a1";

/** The up file raises when the column is already there (a stack that has it applied). */
const already = () => runSql(`select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'shopping_periods' and column_name = 'title';`) !== "0";

/** One rolled-back transaction: the migration (unless the stack already has it) and account A. */
function seeded(...statements: string[]): string[] {
  const sql = [
    "begin;",
    already() ? "" : UP,
    `insert into auth.users (id, email) values ('${A}', 'w7-titles-a@meal-companion.test');`,
    "create temp table r (v text) on commit drop;",
    ...statements,
    "select 'R:' || v from r;",
    "rollback;",
  ].join("\n");
  return runSql(sql).split("\n").filter((line) => line.startsWith("R:")).map((line) => line.slice(2));
}

const record = (expr: string) => `insert into r select (${expr})::text;`;
const insertList = (title: string) => `insert into public.shopping_periods
  (user_id, start_date, end_date, timezone, people, mode, effort, variety, title)
  values ('${A}', '2026-10-19', '2026-10-25', 'UTC', 1, 'simple', 'none', 'balanced', ${title});`;
const attempt = (label: string, title: string) => `
  do $$ begin
    ${insertList(title)}
    insert into r values ('${label}:allowed');
  exception when check_violation then
    insert into r values ('${label}:refused');
  end $$;`;
const titleColumns = `(select count(*) from information_schema.columns where table_schema = 'public'
  and table_name = 'shopping_periods' and column_name = 'title')`;
const titleCheck = `(select count(*) from pg_constraint
  where conname = 'shopping_periods_title_check' and conrelid = 'public.shopping_periods'::regclass)`;

describe.skipIf(!HAS_DB)("shopping period titles migration (rolled back)", () => {
  it("adds a nullable title column", () => {
    expect(seeded(
      record(`(select is_nullable || ':' || data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'shopping_periods' and column_name = 'title')`),
      insertList("default"),
      record(`(select count(*) from public.shopping_periods where user_id = '${A}' and title is null)`),
    )).toEqual(["YES:text", "1"]);
  });

  it("accepts null and a trimmed 1-60 character title; refuses blank, padded and 61 characters", () => {
    expect(seeded(
      attempt("null", "null"),
      attempt("one", "'x'"),
      attempt("sixty", "repeat('a', 60)"),
      attempt("words", "'Weekly shop'"),
      attempt("empty", "''"),
      attempt("blank", "'   '"),
      attempt("padded", "' x '"),
      attempt("leading", "' Weekly'"),
      attempt("sixty-one", "repeat('a', 61)"),
    )).toEqual(["null:allowed", "one:allowed", "sixty:allowed", "words:allowed", "empty:refused",
      "blank:refused", "padded:refused", "leading:refused", "sixty-one:refused"]);
  });

  it("the validate file validates the check", () => {
    expect(seeded(
      insertList("'Kept'"),
      VALIDATE,
      record(`(select convalidated from pg_constraint where conname = 'shopping_periods_title_check')`),
      // A row written after validation is still held to the check.
      attempt("after", "' padded '"),
    )).toEqual(["true", "after:refused"]);
  });

  it("the down file removes the column and its check when no list has a title", () => {
    expect(seeded(
      VALIDATE,
      insertList("null"),
      VALIDATE_DOWN,
      DOWN,
      record(titleColumns),
      record(titleCheck),
      record(`(select count(*) from public.shopping_periods where user_id = '${A}')`),
    )).toEqual(["0", "0", "1"]);
  });

  it("the down file refuses while a list has a title", () => {
    expect(() => seeded(insertList("'Weekly shop'"), DOWN))
      .toThrow(/lists have titles; set app\.allow_down_data_loss = on/);
  });

  it("the down file drops titles when app.allow_down_data_loss = on", () => {
    expect(seeded(
      insertList("'Weekly shop'"),
      "select set_config('app.allow_down_data_loss', 'on', true);",
      DOWN,
      record(titleColumns),
      record(titleCheck),
    )).toEqual(["0", "0"]);
  });
});
