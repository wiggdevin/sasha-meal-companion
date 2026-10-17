/**
 * W048 step 1: migration 20270105110000_sync_op_receipts writes one receipt per applied op_id from
 * a trigger on change_log, backfills the existing ones, and makes apply_sync_op answer a replay
 * 'duplicate' from the receipt, so the answer survives the change_log row being pruned.
 *
 * The database half runs on a real, throwaway Postgres (initdb into a temp dir, the
 * tests/migrations/sync-conflict-at-db.test.ts pattern). The prelude stands in for auth and the
 * sync internals; apply_sync_op is the REAL definition cut from its last full migration, patched by
 * 20261231180000 first, so the anchor patch runs on the text production runs. Needs the Postgres
 * server binaries (PG_BIN, default Homebrew postgresql@16); skipped without them. It never connects
 * to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const NAME = "20270105110000_sync_op_receipts";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const UP_FILE = path.join(MIGRATIONS, `${NAME}.sql`);
const DOWN_FILE = path.join(MIGRATIONS, "down", `${NAME}.down.sql`);
const CONFLICT_AT = path.join(MIGRATIONS, "20261231180000_sync_conflict_at.sql");
const LAST_FULL = "20260919090300_phase3_sync_entities.sql";
const ANCHOR = "  if exists (select 1 from change_log where op_id = v_op_id) then";
const read = (file: string) => readFileSync(file, "utf8");

function realApplySyncOp(): string {
  const text = read(path.join(MIGRATIONS, LAST_FULL));
  const start = text.indexOf("create or replace function apply_sync_op(");
  const end = text.indexOf("end; $$;", start);
  if (start < 0 || end < 0) throw new Error(`apply_sync_op not found in ${LAST_FULL}`);
  return text.slice(start, end + "end; $$;".length);
}

describe(`${NAME}.sql (static)`, () => {
  it("patches the one replay check of the last full apply_sync_op", () => {
    expect(realApplySyncOp().split(ANCHOR).length - 1).toBe(1);
    const up = read(UP_FILE);
    expect(up).toContain(`anchor text := $a$${ANCHOR}$a$;`);
    expect(up).toContain("set local lock_timeout = '3s';");
    expect(up).toContain("refusing a partial function");
    expect(up).toContain("revoke all on function public._sync_op_receipt() from public, anon, authenticated;");
    expect(up).not.toMatch(/grant (insert|update|delete|all)[^;]*sync_op_receipts[^;]* to authenticated/);
    expect(read(DOWN_FILE)).toContain("drop table if exists public.sync_op_receipts;");
  });
});

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

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

const PRELUDE = `
do $$ begin
  create role anon; create role authenticated; create role service_role;
exception when duplicate_object then null; end $$;
create schema auth;
grant usage on schema auth to authenticated;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $f$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
insert into auth.users values ('${A}'), ('${B}');
create table change_log (user_id uuid not null, seq bigint not null, entity text not null,
  entity_key text not null, rev integer not null, op text not null, op_id uuid, current jsonb,
  at timestamptz not null default now(), primary key (user_id, seq));
create unique index change_log_op_id on change_log (op_id) where op_id is not null;
create table change_seq (user_id uuid primary key, next_seq bigint not null);
create function next_change_seq(p_user_id uuid) returns bigint language sql as $f$
  insert into change_seq (user_id, next_seq) values (p_user_id, 2)
    on conflict (user_id) do update set next_seq = change_seq.next_seq + 1
    returning next_seq - 1; $f$;
create table water_log (user_id uuid not null, local_date date not null, cups integer not null,
  rev integer not null, primary key (user_id, local_date));
create function _sync_assert_caller(p_user_id uuid) returns void language sql as $f$ select $f$;
create function _sync_assert_key(p_entity text, p_key text) returns void language sql as $f$ select $f$;
create function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
  language sql as $f$
  select to_jsonb(w) - 'user_id' from water_log w where w.user_id = p_user_id and w.local_date = p_key::date $f$;
create function _sync_upsert(p_user_id uuid, p_entity text, p_key text, p_payload jsonb, p_rev integer)
  returns jsonb language plpgsql as $f$ begin
  insert into water_log values (p_user_id, p_key::date, (p_payload->>'cups')::integer, p_rev)
    on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
  return _sync_current(p_user_id, p_entity, p_key);
end $f$;
create function _sync_tombstone(p_user_id uuid, p_entity text, p_key text, p_kind text, p_rev integer)
  returns jsonb language sql as $f$ select null::jsonb $f$;
`;

function op(opId: string, kind: string, base: number | null, key = "2026-10-11", user = A): Record<string, unknown> {
  const raw = sql(`select apply_sync_op('${user}', '${JSON.stringify({ op_id: opId, entity: "water_log",
    entity_id: key, kind, base_rev: base, payload: { local_date: key, cups: 3 },
    client_ts: new Date().toISOString() })}'::jsonb)`);
  return JSON.parse(raw) as Record<string, unknown>;
}
const receipts = (where = "true") => Number(sql(`select count(*) from sync_op_receipts where ${where}`));

describe.skipIf(!HAS_PG)(`${NAME} on Postgres`, () => {
  const before = crypto.randomUUID();

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "op-receipts-pg-"));
    port = 54_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), `${PRELUDE}\n${realApplySyncOp()}\n`);
    runFile(path.join(dir, "prelude.sql"));
    runFile(CONFLICT_AT);
    // An op applied before the migration, and a row with no op id: the backfill takes only the first.
    expect(op(before, "create", null, "2026-01-01").status).toBe("applied");
    sql(`insert into change_log (user_id, seq, entity, entity_key, rev, op) values ('${B}', 1, 'x', 'k', 1, 'create')`);
    runFile(UP_FILE);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { sql("delete from water_log where local_date <> '2026-01-01'"); });

  it("backfills a receipt for every change_log row with an op id", () => {
    expect(receipts(`op_id = '${before}' and user_id = '${A}' and outcome = 'applied'`)).toBe(1);
    expect(receipts(`user_id = '${B}'`)).toBe(0);
  });

  it("an op that was applied before the migration is still a duplicate once its change_log row is gone", () => {
    sql(`delete from change_log where op_id = '${before}'`);
    expect(op(before, "update", 1, "2026-01-01")).toEqual({ op_id: before, status: "duplicate" });
  });

  it("a replay is a duplicate when the change_log row is gone, and writes nothing", () => {
    const id = crypto.randomUUID();
    expect(op(id, "create", null).status).toBe("applied");
    expect(receipts(`op_id = '${id}' and user_id = '${A}'`)).toBe(1);
    expect(op(id, "create", null)).toEqual({ op_id: id, status: "duplicate" });
    sql(`delete from change_log where op_id = '${id}'`);
    sql("delete from water_log where local_date = '2026-10-11'");
    expect(op(id, "create", null)).toEqual({ op_id: id, status: "duplicate" });
    expect(sql("select count(*) from water_log where local_date = '2026-10-11'")).toBe("0");
    expect(sql(`select count(*) from change_log where op_id = '${id}'`)).toBe("0");
  });

  it("a conflict, a gone and a no-op restore write no receipt", () => {
    const first = crypto.randomUUID();
    expect(op(first, "create", null).status).toBe("applied");
    const conflict = crypto.randomUUID();
    expect(op(conflict, "update", 7).status).toBe("conflict");
    const gone = crypto.randomUUID();
    expect(op(gone, "update", 1, "2026-12-31").status).toBe("gone");
    expect(receipts(`op_id in ('${conflict}', '${gone}')`)).toBe(0);
  });

  it("covers any change_log writer, and an op id with a receipt cannot be written again", () => {
    const id = crypto.randomUUID();
    sql(`insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id)
      values ('${B}', 50, 'target_profiles', 'r', 1, 'create', '${id}')`);
    expect(receipts(`op_id = '${id}' and user_id = '${B}'`)).toBe(1);
    sql(`delete from change_log where op_id = '${id}'`);
    expect(() => sql(`insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id)
      values ('${B}', 51, 'target_profiles', 'r', 2, 'update', '${id}')`)).toThrow(/sync_op_receipts_pkey/);
  });

  it("is owner-read only for authenticated", () => {
    const id = crypto.randomUUID();
    expect(op(id, "create", null, "2026-10-12").status).toBe("applied");
    const as = (user: string, text: string) => sql(`begin; set local role authenticated;
      set local request.jwt.claim.sub = '${user}'; ${text}; commit;`);
    expect(as(B, `select count(*) from sync_op_receipts where op_id = '${id}'`)).toBe("0");
    expect(as(A, `select count(*) from sync_op_receipts where op_id = '${id}'`)).toBe("1");
    expect(() => as(A, `insert into sync_op_receipts (op_id, user_id) values ('${crypto.randomUUID()}', '${A}')`))
      .toThrow(/permission denied/);
    expect(() => as(A, `delete from sync_op_receipts where op_id = '${id}'`)).toThrow(/permission denied/);
  });

  it("re-running the migration changes nothing, and the down file restores the change_log check", () => {
    const def = () => sql("select pg_get_functiondef('public.apply_sync_op(uuid,jsonb)'::regprocedure)");
    const patched = def();
    runFile(UP_FILE);
    expect(def()).toBe(patched);
    runFile(DOWN_FILE);
    expect(def()).toContain(ANCHOR);
    expect(def()).not.toContain("sync_op_receipts");
    expect(def()).toContain("_sync_written_at");
    expect(sql("select to_regclass('public.sync_op_receipts') is null")).toBe("t");
    runFile(UP_FILE);
    expect(def()).toBe(patched);
  });
});
