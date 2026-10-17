/**
 * W067 (audit 2026-10-10 F26: A106, A107, A108): migration 20270104090000_care_ledger_fixes.
 *
 * - `care_balance` sums the whole ledger in SQL, so 1,001+ rows give the exact balance and
 *   pending sum (the JS sum of a plain select stopped at the API's 1,000-row cap).
 * - `care_points_sync` takes the phone's day within one date of the stored zone's today and
 *   clamps it beyond that, never raising 22023 `future_date`.
 * - `care_accolades_sync` grants full-week for the closed week before the account's day on any
 *   sync, not only on a Sunday.
 *
 * Runs the REAL care migrations (20261225090100, 20261225090300) and the new file on a
 * throwaway Postgres (initdb into a temp dir, the tests/migrations/sync-conflict-at-db.test.ts
 * pattern); the prelude stands in only for the tables and helpers they read. Needs the Postgres
 * server binaries (PG_BIN, default Homebrew postgresql@16); skipped without them. It never
 * connects to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const NAME = "20270104090000_care_ledger_fixes";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const UP_FILE = path.join(MIGRATIONS, `${NAME}.sql`);
const DOWN_FILE = path.join(MIGRATIONS, "down", `${NAME}.down.sql`);
const LEDGER_FILE = path.join(MIGRATIONS, "20261225090100_care_points_ledger.sql");
const ACCOLADES_FILE = path.join(MIGRATIONS, "20261225090300_care_accolades.sql");
const read = (file: string) => readFileSync(file, "utf8");

describe(`${NAME}.sql (static)`, () => {
  it("is the last file to define the care sync functions, and grants care_balance as they are", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f > `${NAME}.sql`);
    for (const file of later) {
      expect(read(path.join(MIGRATIONS, file)), file)
        .not.toMatch(/function (public\.)?(care_points_sync|care_accolades_sync|care_balance)\b/);
    }
    const up = read(UP_FILE);
    expect(up).toContain("set local lock_timeout = '3s';");
    expect(up).not.toContain("raise exception 'future_date'");
    expect(up).toContain("revoke all on function public.care_balance(uuid) from public, anon, authenticated;");
    expect(up).toContain("grant execute on function public.care_balance(uuid) to authenticated, service_role;");
    expect(read(DOWN_FILE)).toContain("drop function if exists public.care_balance(uuid);");
  });
});

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
/** The stored zone's today, as the functions compute it. */
const TODAY = "(now() at time zone 'UTC')::date";

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);

function psql(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}
function sql(text: string): string {
  const r = psql(["-c", text]);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
function runFile(file: string): void {
  const r = psql(["-1", "-f", file]);
  if (r.status !== 0) throw new Error(r.stderr);
}
const json = (text: string) => JSON.parse(sql(text)) as Record<string, unknown>;

/** Only the tables and helpers the two care migrations read, with the columns they read. */
const PRELUDE = `
do $$ begin
  create role anon; create role authenticated; create role service_role;
exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
-- 20260911000600_rpc.sql's own body.
create function _sync_assert_caller(p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = public as $f$
declare v_caller uuid := auth.uid();
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  if v_caller is not null and v_caller <> p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end; $f$;
create table user_settings (user_id uuid primary key, time_zone text, training_weekdays smallint[],
  diet_prefs jsonb, water_goal_cups_training integer, water_goal_cups_rest integer, weight_kg numeric);
create table log_entries (user_id uuid not null, local_date date not null, slot text not null,
  deleted_at timestamptz);
create table plan_days (user_id uuid not null, local_date date not null, day_complete_at timestamptz,
  day_type_override text);
create table water_log (user_id uuid not null, local_date date not null, cups integer);
create table target_profiles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  effective_from date not null, rev integer not null, mode text, kcal_train numeric,
  protein_pct numeric, protein_g numeric, protein_g_min numeric, input_weight_kg numeric);
create table daily_totals (user_id uuid not null, local_date date not null, nutrient_code text not null,
  amount numeric, items_with_value integer);
create table health_samples (user_id uuid not null, type text not null, start_time timestamptz not null);
create table recipe_plan_selections (user_id uuid not null);
insert into auth.users values ('${A}'), ('${B}');
insert into user_settings (user_id, time_zone) values ('${A}', 'UTC'), ('${B}', 'UTC');
`;

/** Two meal occasions on the date `offset` days from the stored zone's today. */
const twoMeals = (offset: number) => `insert into log_entries (user_id, local_date, slot)
  values ('${A}', ${TODAY} + ${offset}, 'm1'), ('${A}', ${TODAY} + ${offset}, 'm2')`;
const syncPoints = (offset: number) =>
  `select care_points_sync('${A}', ${TODAY} + ${offset}, 'UTC')`;
const dayRecorded = () => sql(`select string_agg((local_date - ${TODAY})::text || ':' || status, ',' order by local_date)
  from care_points_ledger where user_id = '${A}' and kind = 'day_recorded'`);

describe.skipIf(!HAS_PG)(`${NAME} on Postgres`, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "care-ledger-pg-"));
    port = 54_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), PRELUDE);
    runFile(path.join(dir, "prelude.sql"));
    runFile(LEDGER_FILE);
    runFile(ACCOLADES_FILE);
    runFile(UP_FILE);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { sql("truncate care_points_ledger, care_accolades, log_entries"); });

  it("care_balance sums every row past 1,000: 1,001 settled and 3 pending", () => {
    sql(`insert into care_points_ledger (user_id, event_key, rule_version, kind, delta, local_date,
           zone, status)
         select '${A}', 'seed:' || g, 'v1', 'day_recorded', 2, date '2026-01-01', 'UTC', 'settled'
           from generate_series(1, 1001) g`);
    sql(`insert into care_points_ledger (user_id, event_key, rule_version, kind, delta, local_date,
           zone, status)
         select '${A}', 'pend:' || g, 'v1', 'water_goal', 1, date '2026-01-02', 'UTC', 'pending'
           from generate_series(1, 3) g`);
    expect(json(`select care_balance('${A}')`)).toEqual({ balance: 2002, pending: 3 });
    expect(json(`select care_balance('${B}')`)).toEqual({ balance: 0, pending: 0 });
  });

  it("care_balance refuses another account's id", () => {
    const r = psql(["-c", `select set_config('request.jwt.claim.sub', '${B}', false);
      select care_balance('${A}')`]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("forbidden");
  });

  it("a phone day one date ahead of the stored zone syncs, and mints a pending row for that day", () => {
    sql(twoMeals(1));
    expect(json(syncPoints(1))).toMatchObject({ balance: 0, pending: 2 });
    expect(dayRecorded()).toBe("1:pending");
  });

  it("a phone day one date behind mints for that day, and it settles only on a later sync", () => {
    sql(twoMeals(-1));
    expect(json(syncPoints(-1))).toMatchObject({ balance: 0, pending: 2 });
    expect(dayRecorded()).toBe("-1:pending");
    expect(json(syncPoints(0))).toMatchObject({ balance: 2, pending: 0 });
    expect(dayRecorded()).toBe("-1:settled");
  });

  it("a day-behind award whose evidence is gone by the next sync is dropped, never settled", () => {
    sql(twoMeals(-1));
    json(syncPoints(-1));
    sql(`update log_entries set deleted_at = now() where user_id = '${A}'`);
    expect(json(syncPoints(0))).toMatchObject({ balance: 0, pending: 0 });
    expect(dayRecorded()).toBe("");
  });

  it("a date further out is clamped to the stored zone's today, never refused", () => {
    sql(twoMeals(0));
    sql(twoMeals(5));
    expect(json(syncPoints(5))).toMatchObject({ pending: 2 });
    expect(json(syncPoints(-5))).toMatchObject({ pending: 2 });
    expect(dayRecorded()).toBe("0:pending");
  });

  it("full-week is granted for the previous closed week on any weekday", () => {
    sql(`insert into log_entries (user_id, local_date, slot)
         select '${A}', (${TODAY} - extract(isodow from ${TODAY})::int - 6) + g, 'm1'
           from generate_series(0, 6) g`);
    expect(json(`select care_accolades_sync('${A}', ${TODAY}, 'UTC')`).granted).toContain("full-week");
    expect(sql(`select (evidence->>'week')::date = ${TODAY} - extract(isodow from ${TODAY})::int - 6
      from care_accolades where user_id = '${A}' and key = 'full-week'`)).toBe("t");
  });

  it("full-week is not granted for a week missing a date", () => {
    sql(`insert into log_entries (user_id, local_date, slot)
         select '${A}', (${TODAY} - extract(isodow from ${TODAY})::int - 6) + g, 'm1'
           from generate_series(0, 5) g`);
    expect(json(`select care_accolades_sync('${A}', ${TODAY}, 'UTC')`).granted).not.toContain("full-week");
  });

  it("the down file restores the old bodies and the up file applies again", () => {
    runFile(DOWN_FILE);
    const r = psql(["-c", syncPoints(1)]);
    expect(r.stderr).toContain("future_date");
    runFile(UP_FILE);
    expect(json(syncPoints(1))).toHaveProperty("balance");
  });
});
