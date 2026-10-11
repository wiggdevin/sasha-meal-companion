/**
 * W006 (audit 2026-10-10 A075, A098, P20): migration 20261231130000 dates an approved proposal and
 * reads the revision in force by the account's day, and records the day marking began instead of
 * the earliest marked date.
 *
 * Runs on a real, throwaway Postgres (initdb into a temp dir, the recipe-energy-rule-db pattern).
 * approve_target_proposal is created from its full definition (20261023090500), with stand-ins for
 * the tables and the revision writer it calls, so the migration's anchor patch runs against the
 * text production holds (later patches touch other lines). Needs the Postgres server binaries
 * (PG_BIN, default Homebrew postgresql@16); skipped without them. It never connects to Supabase.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NAME = "20261231130000_w006_account_day_approval_marks";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const UP_FILE = path.join(MIGRATIONS, `${NAME}.sql`);
const DOWN_FILE = path.join(MIGRATIONS, "down", `${NAME}.down.sql`);
const APPROVE_FILE = path.join(MIGRATIONS, "20261023090500_approve_proposal_via_revision.sql");
const MARK_FILE = path.join(MIGRATIONS, "20261209090100_plan_days_day_complete.sql");
const read = (file: string) => readFileSync(file, "utf8");

/** The original first-mark trigger, cut from its migration (the rest of that file patches sync). */
function originalTrigger(): string {
  const text = read(MARK_FILE);
  return text.slice(text.indexOf("create function public.plan_days_record_first_mark()"));
}

describe(`${NAME}.sql (static)`, () => {
  it("patches by anchor, refuses a partial patch, and grants only service_role", () => {
    const up = read(UP_FILE);
    expect(up).toContain("refusing a partial function");
    expect(up).toContain("set local lock_timeout = '3s';");
    expect(up).not.toMatch(/grant [^;]* to (authenticated|anon|public)/);
    expect(read(DOWN_FILE)).toContain("drop function if exists public._account_local_date(uuid);");
    expect(read(DOWN_FILE)).not.toMatch(/grant [^;]* to (authenticated|anon|public)/);
  });
});

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const USER = "00000000-0000-4000-8000-0000000000a1";

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);
function psql(args: string[]): string {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const sql = (text: string) => psql(["-c", text]);
const runFile = (file: string) => psql(["-1", "-f", file]);

/** Resets the account: zone, two revisions (today and tomorrow, account time) and one proposal. */
function scenario(zone: string | null): { today: string } {
  sql(`truncate target_profiles, target_proposals, written, change_log, plan_days, user_settings;`);
  sql(`insert into user_settings (user_id, time_zone, training_weekdays)
       values ('${USER}', ${zone === null ? "null" : `'${zone}'`}, '{1,3}');`);
  const today = sql(`select (now() at time zone ${zone === null ? "'UTC'" : `'${zone}'`})::date;`);
  sql(`insert into target_profiles (id, user_id, effective_from, rev, kcal_min)
       values (gen_random_uuid(), '${USER}', '${today}'::date - 30, 1, 1500),
              (gen_random_uuid(), '${USER}', '${today}'::date + 1, 2, 1900);`);
  sql(`insert into target_proposals (id, user_id, status, week_start, proposed)
       values ('00000000-0000-4000-8000-0000000000b1', '${USER}', 'pending', '${today}'::date - 10,
         '{"kcalTrain":2000,"kcalRest":1800,"proteinG":120,"fatG":60,"carbG":245}');`);
  return { today };
}
const approve = () => JSON.parse(sql(
  `select approve_target_proposal('${USER}', '00000000-0000-4000-8000-0000000000b1');`)) as { status: string };
const written = () => JSON.parse(sql(`select payload from written;`)) as Record<string, unknown>;

describe.skipIf(!HAS_PG)(`${NAME}.sql on a throwaway Postgres`, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "w006-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + read(path.join(dir, "log")));
    // Stand-ins for the Supabase pieces the two functions read and call.
    writeFileSync(path.join(dir, "prelude.sql"), `
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create table user_settings (user_id uuid primary key, time_zone text, training_weekdays int[],
        activity_level text, goal text, day_marks_started_on date);
      create table target_profiles (id uuid primary key, user_id uuid, effective_from date, rev int,
        kcal_min int, protein_g_min numeric, fat_g_min numeric, carb_g_min numeric,
        goal_rate_bp_week int, max_weekly_kcal_step int, kcal_min_source text);
      create table expenditure_estimates (id uuid primary key, user_id uuid, weight_trend_kg numeric);
      create table target_proposals (id uuid primary key, user_id uuid, status text, week_start date,
        proposed jsonb, based_on_estimate_id uuid, decided_at timestamptz, decided_by uuid);
      create table change_log (user_id uuid, seq bigint, entity text, entity_key text, rev int,
        op text, op_id uuid, current jsonb);
      create table written (payload jsonb);
      create table plan_days (user_id uuid, local_date date, day_complete_at timestamptz,
        primary key (user_id, local_date));
      create function _sync_assert_caller(p uuid) returns void language sql as $$ select $$;
      create function next_change_seq(p uuid) returns bigint language sql as $$ select 1::bigint $$;
      create function write_target_revision(p_user_id uuid, p_row jsonb) returns jsonb
        language plpgsql as $$ begin
          insert into written values (p_row);
          return jsonb_build_object('id', gen_random_uuid(), 'user_id', p_user_id,
            'effective_from', p_row->>'effective_from', 'rev', 3);
        end $$;
      ${originalTrigger()}`);
    runFile(path.join(dir, "prelude.sql"));
    runFile(APPROVE_FILE);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("before the migration, approval dates the revision to the past week_start (the defect)", () => {
    const { today } = scenario("America/Los_Angeles");
    expect(approve().status).toBe("approved");
    expect(written().effective_from).toBe(sql(`select ('${today}'::date - 10)::text;`));
  });

  it("before the migration, a back-dated mark moves day_marks_started_on to that date (the defect)", () => {
    scenario(null);
    sql(`insert into plan_days values ('${USER}', '2020-01-15', now());`);
    expect(sql(`select day_marks_started_on from user_settings;`)).toBe("2020-01-15");
  });

  it("applies, and a second run is a no-op", () => {
    runFile(UP_FILE);
    runFile(UP_FILE);
    expect(sql(`select count(*) from pg_proc where proname = 'approve_target_proposal';`)).toBe("1");
    expect(sql(`select has_function_privilege('authenticated',
      'approve_target_proposal(uuid,uuid)', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated',
      '_account_local_date(uuid)', 'execute');`)).toBe("f");
  });

  it.each(["America/Los_Angeles", "Pacific/Kiritimati", "Etc/GMT+12"])(
    "approval takes effect on the account's day and reads the revision in force then (%s)", (zone) => {
      const { today } = scenario(zone);
      expect(approve().status).toBe("approved");
      const payload = written();
      expect(payload.effective_from).toBe(today);
      // Tomorrow's scheduled revision (kcal_min 1900) is not in force yet.
      expect(payload.kcal_min).toBe(1500);
    });

  it("falls back to UTC for a zone Postgres does not know, or none", () => {
    const utc = sql(`select (now() at time zone 'UTC')::date;`);
    for (const zone of ["Not/A_Zone", null]) {
      scenario(null);
      sql(`update user_settings set time_zone = ${zone === null ? "null" : `'${zone}'`};`);
      expect(sql(`select public._account_local_date('${USER}');`)).toBe(utc);
    }
  });

  it("the first mark records the account's day; a back-dated or later mark never moves it", () => {
    const { today } = scenario("Pacific/Kiritimati");
    sql(`insert into plan_days values ('${USER}', '2020-01-15', now());`);
    expect(sql(`select day_marks_started_on from user_settings;`)).toBe(today);
    sql(`insert into plan_days values ('${USER}', '2019-06-01', now());`);
    sql(`update plan_days set day_complete_at = null where local_date = '2020-01-15';`);
    expect(sql(`select day_marks_started_on from user_settings;`)).toBe(today);
  });

  it("down restores both bodies and drops the helper", () => {
    runFile(DOWN_FILE);
    expect(sql(`select count(*) from pg_proc where proname = '_account_local_date';`)).toBe("0");
    const { today } = scenario("America/Los_Angeles");
    expect(approve().status).toBe("approved");
    expect(written().effective_from).toBe(sql(`select ('${today}'::date - 10)::text;`));
    runFile(UP_FILE);
  });
});
