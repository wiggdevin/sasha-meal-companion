/**
 * W026 (backlog B234): migration 20261231180000_sync_conflict_at gives apply_sync_op's two
 * conflict answers an `at`, the time the server's row was written, and changes nothing else.
 *
 * The database half runs on a real, throwaway Postgres (initdb into a temp dir, the
 * coach-undo-sql.test.ts pattern). The prelude stands in for the sync internals apply_sync_op
 * calls; apply_sync_op itself is the REAL definition cut from its last full migration
 * (20260919090300_phase3_sync_entities.sql), so the anchor patch runs on the text production runs.
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const NAME = "20261231180000_sync_conflict_at";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const UP_FILE = path.join(MIGRATIONS, `${NAME}.sql`);
const DOWN_FILE = path.join(MIGRATIONS, "down", `${NAME}.down.sql`);
const LAST_FULL = "20260919090300_phase3_sync_entities.sql";
const read = (file: string) => readFileSync(file, "utf8");

/** apply_sync_op exactly as its last full definition writes it. */
function realApplySyncOp(): string {
  const text = read(path.join(MIGRATIONS, LAST_FULL));
  const start = text.indexOf("create or replace function apply_sync_op(");
  const end = text.indexOf("end; $$;", start);
  if (start < 0 || end < 0) throw new Error(`apply_sync_op not found in ${LAST_FULL}`);
  return text.slice(start, end + "end; $$;".length);
}

describe(`${NAME}.sql (static)`, () => {
  it("patches the last full apply_sync_op, and no later file redefines it", () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f > LAST_FULL && f !== `${NAME}.sql`);
    for (const file of later) {
      expect(read(path.join(MIGRATIONS, file)), file)
        .not.toMatch(/create (or replace )?function (public\.)?apply_sync_op\b/);
    }
    expect(realApplySyncOp().split("'status', 'conflict'").length - 1).toBe(2);
  });

  it("is live-safe, refuses a partial patch, and grants the helper to service_role only", () => {
    const up = read(UP_FILE);
    expect(up).toContain("set local lock_timeout = '3s';");
    expect(up).toContain("refusing a partial function");
    expect(up).toContain("revoke all on function public._sync_written_at(uuid, text, text, jsonb) from public, anon, authenticated;");
    expect(up).not.toMatch(/grant [^;]*_sync_written_at[^;]* to (authenticated|anon)/);
    expect(read(DOWN_FILE)).toContain("drop function if exists public._sync_written_at(uuid, text, text, jsonb);");
  });
});

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const A = "aaaaaaaa-0000-4000-8000-00000000000a";

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

/** The sync internals apply_sync_op calls, for one date-keyed table. */
const PRELUDE = `
do $$ begin
  create role anon; create role authenticated; create role service_role;
exception when duplicate_object then null; end $$;
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
create table gut_log (id uuid primary key, user_id uuid not null, note text, rev integer not null,
  updated_at timestamptz not null);
create function _sync_assert_caller(p_user_id uuid) returns void language sql as $f$ select $f$;
create function _sync_assert_key(p_entity text, p_key text) returns void language sql as $f$ select $f$;
create function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
  language plpgsql as $f$ begin
  if p_entity = 'water_log' then
    return (select to_jsonb(w) - 'user_id' from water_log w
      where w.user_id = p_user_id and w.local_date = p_key::date);
  end if;
  return (select to_jsonb(g) - 'user_id' from gut_log g where g.user_id = p_user_id and g.id = p_key::uuid);
end $f$;
create function _sync_upsert(p_user_id uuid, p_entity text, p_key text, p_payload jsonb, p_rev integer)
  returns jsonb language plpgsql as $f$ begin
  insert into water_log values (p_user_id, p_key::date, (p_payload->>'cups')::integer, p_rev)
    on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
  return _sync_current(p_user_id, p_entity, p_key);
end $f$;
create function _sync_tombstone(p_user_id uuid, p_entity text, p_key text, p_kind text, p_rev integer)
  returns jsonb language sql as $f$ select null::jsonb $f$;
`;

function op(kind: string, base: number | null, cups = 3, entity = "water_log", key = "2026-10-11"): Record<string, unknown> {
  const raw = sql(`select apply_sync_op('${A}', '${JSON.stringify({ op_id: crypto.randomUUID(), entity,
    entity_id: key, kind, base_rev: base, payload: { local_date: key, cups },
    client_ts: new Date().toISOString() })}'::jsonb)`);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe.skipIf(!HAS_PG)(`${NAME} on Postgres`, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sync-conflict-at-pg-"));
    port = 54_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), `${PRELUDE}\n${realApplySyncOp()}\n`);
    runFile(path.join(dir, "prelude.sql"));
    runFile(UP_FILE);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { sql("truncate change_log, change_seq, water_log, gut_log"); });

  it("answers both conflicts with the time of the row's last change", () => {
    expect(op("create", null)).toMatchObject({ status: "applied", rev: 1, seq: 1 });
    sql(`update change_log set at = '2026-10-11T07:00:00Z' where seq = 1`);
    const atLogged = Date.parse("2026-10-11T07:00:00Z");

    const create = op("create", null);
    expect(create).toMatchObject({ status: "conflict", current_rev: 1 });
    expect(Date.parse(String(create.at))).toBe(atLogged);

    const stale = op("update", 0);
    expect(stale).toMatchObject({ status: "conflict", current_rev: 1 });
    expect(Date.parse(String(stale.at))).toBe(atLogged);
  });

  it("takes the row's updated_at when it is later than its last change, and now() with neither", () => {
    const id = crypto.randomUUID();
    sql(`insert into gut_log values ('${id}', '${A}', 'x', 1, '2026-10-11T09:30:00Z')`);
    const written = op("update", 0, 3, "gut_log", id);
    expect(written.status).toBe("conflict");
    expect(Date.parse(String(written.at))).toBe(Date.parse("2026-10-11T09:30:00Z"));

    sql(`insert into water_log values ('${A}', '2026-10-12', 1, 4)`);
    const before = Date.now() - 60_000;
    const unlogged = op("update", 1, 3, "water_log", "2026-10-12");
    expect(unlogged.status).toBe("conflict");
    expect(Date.parse(String(unlogged.at))).toBeGreaterThan(before);
  });

  it("leaves every other answer as it was", () => {
    expect(op("update", 1)).toEqual({ op_id: expect.any(String), status: "gone" });
    expect(op("create", null)).toEqual({ op_id: expect.any(String), status: "applied", rev: 1, seq: 1 });
    expect(op("update", 1, 5)).toEqual({ op_id: expect.any(String), status: "applied", rev: 2, seq: 2 });
  });

  it("is idempotent, and its down file restores the conflict answer without `at`", () => {
    runFile(UP_FILE);
    op("create", null);
    expect(op("create", null)).toHaveProperty("at");
    runFile(DOWN_FILE);
    const conflict = op("create", null);
    expect(conflict.status).toBe("conflict");
    expect(conflict).not.toHaveProperty("at");
    expect(sql(`select count(*) from pg_proc where proname = '_sync_written_at'`)).toBe("0");
    runFile(UP_FILE);
    expect(op("create", null)).toHaveProperty("at");
  });
});
