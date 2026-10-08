/**
 * Phase 18 W11 migration 6 (supabase/migrations/20261227090000_shopping_focus.sql) on a real
 * Postgres (Sol W11 r1 BLOCK 3/4). Needs SUPABASE_TEST_DB_URL (a local stack); skipped without it.
 * Every case applies the migration inside one transaction that is rolled back, so the stack is
 * left as it was.
 *
 * - A direct authenticated write of any focus column is refused; the sync RPC never names them.
 * - The two functions are service_role only, and refuse an end past 31 days.
 * - Two "on" writes in turn: the second records the first's value; Undo of the second restores
 *   the first; Undo of the first after the second is `superseded` and writes nothing; a second
 *   Undo of the same write is `superseded`.
 * - The down file removes every object.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const UP = readFileSync("supabase/migrations/20261227090000_shopping_focus.sql", "utf8");
const DOWN = readFileSync("supabase/migrations/down/20261227090000_shopping_focus.down.sql", "utf8");
const A = "a0000000-0000-4000-8000-0000000000f1";

const already = () => runSql(`select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'user_settings' and column_name = 'shopping_focus_until';`) !== "0";

/** One rolled-back transaction: the migration (unless the stack already has it) and account A. */
function seeded(...statements: string[]): string[] {
  const sql = [
    "begin;",
    already() ? "" : UP,
    `insert into auth.users (id, email) values ('${A}', 'w11-a@meal-companion.test');`,
    `insert into user_settings (user_id, first_opened_at, rev) values ('${A}', now(), 1);`,
    "create temp table r (v text) on commit drop;",
    ...statements,
    "select 'R:' || v from r;",
    "rollback;",
  ].join("\n");
  return runSql(sql).split("\n").filter((line) => line.startsWith("R:")).map((line) => line.slice(2));
}

const record = (expr: string) => `insert into r select (${expr})::text;`;
const actionOf = (n: number) => `(select a from acts where n = ${n})`;
const setInto = (n: number, until: string) =>
  `insert into acts select ${n}, (public.shopping_focus_set('${A}', ${until}) ->> 'actionId')::uuid;`;
const undo = (n: number) => `public.shopping_focus_undo('${A}', ${actionOf(n)}) ->> 'status'`;
const until = `(select shopping_focus_until::text from user_settings where user_id = '${A}')`;

describe.skipIf(!HAS_DB)("shopping focus migration (rolled back)", () => {
  it("refuses a direct authenticated write of each focus column", () => {
    const attempt = (column: string, value: string) => `
      do $$ begin
        begin
          perform set_config('request.jwt.claims', '{"sub":"${A}","role":"authenticated"}', true);
          set local role authenticated;
          update public.user_settings set ${column} = ${value} where user_id = '${A}';
          reset role;
          insert into r values ('${column}:allowed');
        exception when insufficient_privilege then
          insert into r values ('${column}:refused');
        end;
      end $$;`;
    expect(seeded(
      // Control: the same session may still write its own row's other columns.
      attempt("first_opened_at", "first_opened_at"),
      attempt("shopping_focus_until", "now() + interval '400 days'"),
      attempt("shopping_focus_action", "gen_random_uuid()"),
      attempt("shopping_focus_previous", "now()"),
    )).toEqual(["first_opened_at:allowed", "shopping_focus_until:refused", "shopping_focus_action:refused",
      "shopping_focus_previous:refused"]);
  });

  it("lets authenticated execute neither function, and refuses an end past 31 days", () => {
    expect(seeded(
      record(`has_function_privilege('authenticated', 'public.shopping_focus_set(uuid,timestamptz)', 'execute')`),
      record(`has_function_privilege('authenticated', 'public.shopping_focus_undo(uuid,uuid)', 'execute')`),
      record(`has_function_privilege('service_role', 'public.shopping_focus_set(uuid,timestamptz)', 'execute')`),
      `do $$ begin
        perform public.shopping_focus_set('${A}', now() + interval '40 days');
        insert into r values ('far:allowed');
      exception when invalid_parameter_value then insert into r values ('far:refused'); end $$;`,
    )).toEqual(["false", "false", "true", "far:refused"]);
  });

  it("serializes two writes and undoes compare-and-set, never over a later choice", () => {
    const first = "'2026-10-20T00:00:00Z'::timestamptz";
    const second = "'2026-10-25T00:00:00Z'::timestamptz";
    expect(seeded(
      "create temp table acts (n int, a uuid) on commit drop;",
      setInto(1, first),
      setInto(2, second),
      record(`(select shopping_focus_previous::text from user_settings where user_id = '${A}')`),
      // Undo of the first while the second is in place: nothing moves.
      record(undo(1)),
      record(until),
      // Undo of the second restores the first's value, recorded by the server.
      record(undo(2)),
      record(until),
      // A second Undo of the same write is superseded.
      record(undo(2)),
      record(until),
    )).toEqual([
      "2026-10-20 00:00:00+00",
      "superseded", "2026-10-25 00:00:00+00",
      "undone", "2026-10-20 00:00:00+00",
      "superseded", "2026-10-20 00:00:00+00",
    ]);
  });

  it("an Undo after a later off writes nothing", () => {
    expect(seeded(
      "create temp table acts (n int, a uuid) on commit drop;",
      setInto(1, "now() + interval '3 days'"),
      setInto(2, "null"),
      record(undo(1)),
      record(`${until} is null`),
    )).toEqual(["superseded", "true"]);
  });

  it("answers no_settings for an account without a settings row", () => {
    expect(seeded(record(`public.shopping_focus_set('b0000000-0000-4000-8000-0000000000f2', null) ->> 'status'`)))
      .toEqual(["no_settings"]);
  });

  it("the down file removes every object it added", () => {
    const left = runSql([
      "begin;", already() ? "" : UP, DOWN,
      `select count(*) from information_schema.columns where table_schema = 'public'
         and table_name = 'user_settings' and column_name like 'shopping_focus%';`,
      "select count(*) from pg_proc where proname in ('shopping_focus_set', 'shopping_focus_undo', 'user_settings_shopping_focus_guard');",
      "rollback;",
    ].join("\n")).split("\n").filter((line) => /^\d+$/.test(line));
    expect(left).toEqual(["0", "0"]);
  });
});
