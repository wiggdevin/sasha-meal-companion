/**
 * W010 (audit 2026-10-10 F04: A009, A081, A095, A050), migration 20261230091000
 * `health_ingest_record`, on a real, throwaway Postgres: initdb into a temp dir, a prelude with
 * the three health tables as production has them (20260911000400 plus the 20261013090200
 * dedupe key), then the migration file itself.
 *
 * It proves the dedupe event and the samples commit together: a failed apply leaves no event, so
 * the identical retry applies instead of being answered "duplicate". It also proves the correction
 * upsert moves `start_time` and `tz`, and that `weigh_ins` names each reading's source kind.
 *
 * Two database halves. The throwaway half needs the Postgres server binaries (PG_BIN, default
 * Homebrew postgresql@16) and skips without them, so it runs on a developer's machine only. The
 * migrated-stack half runs the same failure-and-retry proof on the local Supabase database every
 * migration has been applied to (SUPABASE_TEST_DB_URL, the CI Integration job), inside one
 * transaction it rolls back. Neither can reach production (tests/tenancy/local-only).
 */
import "../tenancy/local-only";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const MIGRATION = "20261230091000_health_ingest_record.sql";
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read(`supabase/migrations/${MIGRATION}`);
const DOWN = read(`supabase/migrations/down/${MIGRATION.replace(".sql", ".down.sql")}`);
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SRC = "5e5e5e5e-0000-4000-8000-000000000001";
const SCALE = "5e5e5e5e-0000-4000-8000-000000000002";
const MANUAL = "5e5e5e5e-0000-4000-8000-000000000003";

/** The tables as production has them after 20261013090200 (the columns these functions touch). */
const PRELUDE = String.raw`
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
  end if;
end $roles$;
create extension if not exists pgcrypto;
create table health_sources (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  kind text not null, device_label text, revoked_at timestamptz);
create table ingest_events (id uuid primary key default gen_random_uuid(), status text not null,
  user_id uuid not null, error text, source_id uuid not null references health_sources(id),
  payload_hash bytea not null, received_at timestamptz not null default now(),
  unique (source_id, payload_hash));
create table health_samples (id uuid primary key default gen_random_uuid(), type text not null,
  user_id uuid not null, value numeric not null, source_id uuid not null references health_sources(id),
  unit text not null, vendor_sample_id text, vendor_version text, vendor_updated_at timestamptz,
  start_time timestamptz not null, end_time timestamptz not null, tz text not null,
  received_at timestamptz not null default now(), ingest_event_id uuid references ingest_events(id),
  device_label text);
alter table health_samples add constraint health_samples_type_ck check (type in
  ('body_mass','step_count','active_energy','basal_energy','sleep_asleep','sleep_in_bed',
   'resting_heart_rate','hrv_sdnn','readiness_score'));
alter table health_samples add column dedupe_key text generated always as (
  type || ':' || coalesce(vendor_sample_id,
    (extract(epoch from (start_time - timestamptz 'epoch')))::bigint::text
    || '|' || (extract(epoch from (end_time - timestamptz 'epoch')))::bigint::text
    || '|' || coalesce(device_label, ''))) stored;
create unique index health_samples_dedupe on health_samples (user_id, source_id, dedupe_key);
create view weigh_ins with (security_invoker = true) as
  select user_id, id, start_time, (start_time at time zone tz)::date as local_date, value, unit
    from health_samples where type = 'body_mass';
grant select on weigh_ins to authenticated;

-- health_ingest_event as 20260925000000 left it (the new RPC reuses it inside its transaction).
create function health_ingest_event(p_user_id uuid, p_source_id uuid,
                                    p_payload_hash bytea, p_status text)
  returns table(id uuid, is_new boolean)
  language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null or p_source_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not exists (select 1 from health_sources s
                  where s.id = p_source_id and s.user_id = p_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    insert into ingest_events (user_id, source_id, payload_hash, status)
      values (p_user_id, p_source_id, p_payload_hash, coalesce(p_status, 'applied'))
    on conflict (source_id, payload_hash) do update
      set status = 'duplicate'
    returning ingest_events.id, (xmax = 0);
end; $$;

-- A stand-in for a transient apply failure (a timeout, a deploy window): while the switch row
-- exists, every sample insert raises.
create table fail_switch (on_ boolean primary key);
create function fail_when_switched() returns trigger language plpgsql as $$
begin
  if exists (select 1 from fail_switch) then raise exception 'simulated apply failure'; end if;
  return new;
end $$;
create trigger fail_when_switched before insert on health_samples
  for each row execute function fail_when_switched();
insert into health_sources (id, user_id, kind, device_label) values
  ('${SRC}', '${A}', 'health_auto_export', 'HAE'),
  ('${SCALE}', '${A}', 'health_auto_export', 'Withings'),
  ('${MANUAL}', '${A}', 'manual', 'manual');
`;

let dir = "";
let port = 0;

function bin(name: string): string { return path.join(PG_BIN, name); }

function sql(text: string): { out: string; err: string; ok: boolean } {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", text], { encoding: "utf8" });
  return { out: r.stdout.trim(), err: r.stderr.trim(), ok: r.status === 0 };
}

function must(text: string): string {
  const r = sql(text);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}

const sample = (over: Record<string, unknown> = {}) => ({ type: "step_count", value: 6200,
  unit: "count", start_time: "2026-09-19T06:00:00Z", end_time: "2026-09-19T07:00:00Z",
  tz: "America/Denver", vendor_sample_id: "hae:step_count:2026-09-19",
  vendor_updated_at: "2026-09-20T08:00:00Z", device_label: "Apple Watch", ...over });

/** One ingest call, as the route makes it: hash and samples in, `event|is_new|acc|upd|skip` out. */
function record(hash: string, samples: object[], source = SRC) {
  return sql(`select event_id, is_new, accepted, updated, skipped
    from health_ingest_record('${A}', '${source}', '\\x${hash}'::bytea,
      '${JSON.stringify(samples)}'::jsonb)`);
}

describe("20261230091000 health_ingest_record (text)", () => {
  it("is live-safe and service_role only", () => {
    expect(UP).toContain("set local lock_timeout = '3s';");
    expect(code(UP)).toContain(
      "revoke execute on function health_ingest_record(uuid, uuid, bytea, jsonb)\n  from public, anon, authenticated;");
    expect(code(UP)).toContain(
      "grant execute on function health_ingest_record(uuid, uuid, bytea, jsonb) to service_role;");
  });

  it("the correction upsert sets start_time and tz (A095)", () => {
    expect(code(UP)).toMatch(/do update\s+set value = excluded\.value, unit = excluded\.unit,\s+start_time = excluded\.start_time, end_time = excluded\.end_time, tz = excluded\.tz,/);
  });

  it("down drops the RPC and restores the earlier apply body and view", () => {
    expect(code(DOWN)).toContain("drop function if exists health_ingest_record(uuid, uuid, bytea, jsonb);");
    expect(code(DOWN)).not.toContain("start_time = excluded.start_time");
    expect(code(DOWN)).toContain("create view weigh_ins with (security_invoker = true)");
  });
});

describe.skipIf(!HAS_PG)("20261230091000 health_ingest_record on Postgres", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "health-ingest-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), PRELUDE);
    for (const file of [path.join(dir, "prelude.sql"),
      path.join(process.cwd(), "supabase/migrations", MIGRATION)]) {
      const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
        "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
    }
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    must("truncate fail_switch, health_samples, ingest_events");
  });

  it("records the event and applies the samples in one call", () => {
    const r = record("01", [sample()]);
    expect(r.ok).toBe(true);
    const [, isNew, accepted, updated, skipped] = r.out.split("|");
    expect([isNew, accepted, updated, skipped]).toEqual(["t", "1", "0", "0"]);
    expect(must("select count(*) from ingest_events")).toBe("1");
    expect(must("select count(*) from health_samples where ingest_event_id is not null")).toBe("1");
  });

  it("a failed apply leaves no event, so the identical retry applies (A009, A081)", () => {
    must("insert into fail_switch values (true)");
    const failed = record("02", [sample()]);
    expect(failed.ok).toBe(false);
    expect(failed.err).toContain("simulated apply failure");
    expect(must("select count(*) from ingest_events")).toBe("0");
    expect(must("select count(*) from health_samples")).toBe("0");

    must("truncate fail_switch");
    const retry = record("02", [sample()]);
    expect(retry.ok).toBe(true);
    expect(retry.out.split("|").slice(1)).toEqual(["t", "1", "0", "0"]);
    expect(must("select value from health_samples")).toBe("6200");
  });

  it("answers a completed payload's identical resend as a duplicate and writes nothing", () => {
    record("03", [sample()]);
    const before = must("select id, value, ingest_event_id from health_samples");
    const again = record("03", [sample({ value: 9999 })]);
    expect(again.ok).toBe(true);
    expect(again.out.split("|").slice(1)).toEqual(["f", "0", "0", "0"]);
    expect(must("select id, value, ingest_event_id from health_samples")).toBe(before);
    expect(must("select count(*) from ingest_events")).toBe("1");
  });

  it("keeps the ownership refusal and writes nothing for another account's source", () => {
    const r = sql(`select * from health_ingest_record('bbbbbbbb-0000-4000-8000-00000000000b',
      '${SRC}', '\\x04'::bytea, '[]'::jsonb)`);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("forbidden");
    expect(must("select count(*) from ingest_events")).toBe("0");
  });

  it("a correction moves start_time and tz with the value (A095)", () => {
    record("05", [sample({ type: "sleep_asleep", value: 420, unit: "min",
      vendor_sample_id: "hae:sleep_asleep:2026-09-19", start_time: "2026-09-19T05:00:00Z",
      end_time: "2026-09-19T12:00:00Z", tz: "America/Denver" })]);
    const r = record("06", [sample({ type: "sleep_asleep", value: 480, unit: "min",
      vendor_sample_id: "hae:sleep_asleep:2026-09-19", start_time: "2026-09-19T04:00:00Z",
      end_time: "2026-09-19T12:00:00Z", tz: "America/Chicago",
      vendor_updated_at: "2026-09-21T08:00:00Z" })]);
    expect(r.out.split("|").slice(1)).toEqual(["t", "0", "1", "0"]);
    expect(must(`select value, start_time at time zone 'UTC', tz from health_samples`))
      .toBe("480|2026-09-19 04:00:00|America/Chicago");
  });

  it("weigh_ins names each reading's source kind and keeps its columns (A050)", () => {
    record("07", [sample({ type: "body_mass", value: 80.1, unit: "kg",
      vendor_sample_id: "hae:body_mass:2026-09-19", start_time: "2026-09-19T13:00:00Z",
      end_time: "2026-09-19T13:00:00Z" })], SCALE);
    must(`insert into health_samples (user_id, source_id, type, value, unit, start_time, end_time, tz,
      vendor_sample_id) values ('${A}', '${MANUAL}', 'body_mass', 80.4, 'kg', '2026-09-19T13:00:00Z',
      '2026-09-19T13:00:00Z', 'America/Denver', 'manual:2026-09-19')`);
    expect(must(`select local_date, value, unit, source_kind from weigh_ins order by source_kind`))
      .toBe("2026-09-19|80.1|kg|health_auto_export\n2026-09-19|80.4|kg|manual");
    expect(must(`select string_agg(column_name, ',' order by ordinal_position)
      from information_schema.columns where table_name = 'weigh_ins'`))
      .toBe("user_id,id,start_time,local_date,value,unit,source_kind");
    expect(must(`select reloptions::text from pg_class where relname = 'weigh_ins'`))
      .toBe("{security_invoker=true}");
  });

  it("revokes the RPC from anon and authenticated", () => {
    expect(must(`select has_function_privilege('authenticated',
      'health_ingest_record(uuid, uuid, bytea, jsonb)', 'execute')`)).toBe("f");
    expect(must(`select has_function_privilege('anon',
      'health_ingest_record(uuid, uuid, bytea, jsonb)', 'execute')`)).toBe("f");
    expect(must(`select has_function_privilege('service_role',
      'health_ingest_record(uuid, uuid, bytea, jsonb)', 'execute')`)).toBe("t");
  });

  it("the down file applies cleanly after the up", () => {
    // Inside a rolled-back transaction, so the up stays in place for any test that runs after.
    const r = sql(`begin;\n${DOWN}\nrollback;`);
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
  });
});

/**
 * The migrated local stack (CI Integration): the real tables, triggers and grants, with this
 * migration applied by `supabase start`. Everything runs in one transaction that is rolled back.
 * Each call goes through a plpgsql exception block, which is a savepoint: a failed call is undone
 * on its own, as PostgREST undoes a failed request, and the script goes on to look at what is left.
 */
describe.skipIf(!HAS_DB)("20261230091000 health_ingest_record on the migrated stack", () => {
  const U = "c0c0c0c0-0010-4000-8000-0000000000a1";
  const S = "c0c0c0c0-0010-4000-8000-0000000000b1";
  const sleep = (over: Record<string, unknown>) => sample({ type: "sleep_asleep", unit: "min",
    vendor_sample_id: "hae:sleep_asleep:2026-09-19", end_time: "2026-09-19T12:00:00Z", ...over });
  const call = (hash: string, samples: object[]) =>
    `pg_temp.try_record('\\x${hash}'::bytea, '${JSON.stringify(samples)}'::jsonb)`;

  function scenario(): Map<string, string> {
    const out = runSql(`begin;
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at,
        updated_at)
        values ('${U}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'w010-ingest@meal-companion.test', 'x', now(), now());
      insert into health_sources (id, user_id, kind, device_label)
        values ('${S}', '${U}', 'health_auto_export', 'HAE');
      create function pg_temp.try_record(h bytea, s jsonb) returns text
        language plpgsql as $f$
        declare r record;
        begin
          select * into r from health_ingest_record('${U}', '${S}', h, s);
          return 'ok:' || r.is_new || '|' || r.accepted || '|' || r.updated || '|' || r.skipped;
        exception when others then return 'failed:' || sqlerrm;
        end $f$;
      -- A stand-in for a transient apply failure, dropped again below (and rolled back at the end).
      create function public.w010_test_fail_apply() returns trigger language plpgsql as $f$
        begin raise exception 'simulated apply failure'; end $f$;
      create trigger w010_test_fail_apply before insert on health_samples
        for each row execute function public.w010_test_fail_apply();
      select 'failed=' || ${call("0a10", [sample()])};
      select 'events_after_fail=' || count(*) from ingest_events where source_id = '${S}';
      select 'samples_after_fail=' || count(*) from health_samples where source_id = '${S}';
      drop trigger w010_test_fail_apply on health_samples;
      select 'retry=' || ${call("0a10", [sample()])};
      select 'stored=' || value from health_samples where source_id = '${S}';
      select 'resend=' || ${call("0a10", [sample({ value: 9999 })])};
      select 'after_resend=' || count(*) || '|' || max(value)
        from health_samples where source_id = '${S}';
      select 'events=' || count(*) from ingest_events where source_id = '${S}';
      select 'first_sleep=' || ${call("0a11", [sleep({ value: 420,
        start_time: "2026-09-19T05:00:00Z", tz: "America/Denver" })])};
      select 'correction=' || ${call("0a12", [sleep({ value: 480,
        start_time: "2026-09-19T04:00:00Z", tz: "America/Chicago",
        vendor_updated_at: "2026-09-21T08:00:00Z" })])};
      select 'sleep_row=' || value || '|' || to_char(start_time at time zone 'UTC',
        'YYYY-MM-DD HH24:MI') || '|' || tz
        from health_samples where source_id = '${S}' and type = 'sleep_asleep';
      select 'weigh_ins_kind=' || exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'weigh_ins' and column_name = 'source_kind');
      select 'grants=' || has_function_privilege('anon', 'health_ingest_record(uuid,uuid,bytea,jsonb)',
          'execute') || '|' || has_function_privilege('authenticated',
          'health_ingest_record(uuid,uuid,bytea,jsonb)', 'execute') || '|' ||
        has_function_privilege('service_role', 'health_ingest_record(uuid,uuid,bytea,jsonb)', 'execute');
      rollback;`);
    return new Map(out.split("\n").filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  }

  it("a failed apply leaves no event, the retry applies, a resend is a duplicate (A009, A081)", () => {
    const got = scenario();
    expect(got.get("failed")).toBe("failed:simulated apply failure");
    expect(got.get("events_after_fail")).toBe("0");
    expect(got.get("samples_after_fail")).toBe("0");
    expect(got.get("retry")).toBe("ok:true|1|0|0");
    expect(got.get("stored")).toBe("6200");
    expect(got.get("resend")).toBe("ok:false|0|0|0");
    expect(got.get("after_resend")).toBe("1|6200");
    expect(got.get("events")).toBe("1");
    // A095 on the real table: the correction moves the window's start and zone with its value.
    expect(got.get("first_sleep")).toBe("ok:true|1|0|0");
    expect(got.get("correction")).toBe("ok:true|0|1|0");
    expect(got.get("sleep_row")).toBe("480|2026-09-19 04:00|America/Chicago");
    expect(got.get("weigh_ins_kind")).toBe("true");
    expect(got.get("grants")).toBe("false|false|true");
  });
});
