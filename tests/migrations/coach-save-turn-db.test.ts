/**
 * W088 (audit B070): `coach_save_turn` (migration 20270104120000) on a real, throwaway Postgres
 * (initdb into a temp dir, the coach-undo-sql.test.ts pattern). The prelude stands in for the
 * Supabase pieces and the coach tables; the migration file itself is applied as written.
 *
 * It proves: a turn and its new thread land together; a failure mid-call (a refused second row, the
 * chat cap) leaves no empty thread and no half turn; a seq another writer holds is retried inside
 * the function after the thread's last seq, and gives up as `coach_seq_busy` after three tries; the
 * same message id is `coach_message_exists`; a turn always appends after the thread's last seq, whatever
 * seq the caller sent; a direct coach_messages insert running at the same time neither deadlocks
 * with a save nor is blocked by its thread lock (FOR NO KEY UPDATE); another account's thread is not found; the user row's
 * shape is the one the session client's insert policy allowed; only the service role may call it.
 *
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const FILE = path.join(process.cwd(), "supabase/migrations/20270104120000_coach_save_turn.sql");
const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const T1 = "3f1b1a2c-0000-4000-8000-000000000001";
const T2 = "3f1b1a2c-0000-4000-8000-000000000002";
const Q = "3f1b1a2c-0000-4000-8000-0000000000a1";
const R = "3f1b1a2c-0000-4000-8000-0000000000a2";

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);

function sql(text: string, role?: string): { out: string; err: string; ok: boolean } {
  const wrapped = role ? `begin; set local role ${role};\n${text};\ncommit;` : text;
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
  return { out: r.stdout.trim(), err: r.stderr.trim(), ok: r.status === 0 };
}
function must(text: string, role?: string): string {
  const r = sql(text, role);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}

const PRELUDE = String.raw`
do $$ begin
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
exception when duplicate_object then null; end $$;
create extension if not exists pgcrypto;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.coach_threads (id uuid primary key default gen_random_uuid(), title text,
  user_id uuid not null, kind text not null default 'chat', rev int not null default 1,
  last_message_at timestamptz, deleted_at timestamptz,
  summary text constraint coach_threads_summary_len check (summary is null or length(summary) <= 600),
  created_at timestamptz not null default now());
create table public.coach_messages (id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.coach_threads(id) on delete cascade,
  user_id uuid not null, role text not null check (role in ('user','assistant','tool')),
  content text not null default '', seq integer not null, tool_calls jsonb not null default '[]',
  policy_checks jsonb not null default '[]', deflected boolean not null default false,
  model_id text, ai_call_id uuid, review_week date, created_at timestamptz not null default now(),
  constraint coach_messages_thread_seq unique (thread_id, seq));
-- The eight-chat cap, as _coach_chat_insert_guard runs it for the service role.
create function public._cap() returns trigger language plpgsql as $$ begin
  if new.kind = 'chat' and (select count(*) from public.coach_threads
      where user_id = new.user_id and kind = 'chat' and deleted_at is null) >= 8 then
    raise exception 'coach_chat_limit' using errcode = 'P0001';
  end if;
  return new; end $$;
create trigger cap before insert on public.coach_threads for each row execute function public._cap();
-- Test hooks: a reply saying "boom" is refused mid-call; a row saying "slow" pauses a second after
-- the save holds its thread lock and before the row takes its seq; a question saying "squat" makes
-- another writer take the seq right after it, every time.
create function public._hooks() returns trigger language plpgsql as $$ begin
  if new.content = 'boom' then raise exception 'forced failure'; end if;
  if new.content = 'slow' then perform pg_sleep(1); end if;
  if new.content = 'squat' then
    insert into public.coach_messages (thread_id, user_id, role, content, seq)
    values (new.thread_id, new.user_id, 'assistant', 'other', new.seq + 1);
  end if;
  return new; end $$;
create trigger hooks before insert on public.coach_messages for each row execute function public._hooks();
`;

function rowJson(id: string, role: "user" | "assistant", seq: number, extra: Record<string, unknown> = {},
  user = A, thread = T1): Record<string, unknown> {
  return { id, thread_id: thread, user_id: user, role, content: role, seq, tool_calls: [],
    policy_checks: [], deflected: false, model_id: null, ai_call_id: null, ...extra };
}

function save(args: { user?: string; thread?: string; kind?: string; title?: string | null;
  rows: Record<string, unknown>[]; summary?: string | null }, role = "service_role") {
  const lit = (v: string | null | undefined) => v === null || v === undefined ? "null"
    : `'${v.replace(/'/g, "''")}'`;
  return sql(`select public.coach_save_turn(${lit(args.user ?? A)}::uuid, ${lit(args.thread ?? T1)}::uuid,
    ${lit(args.kind ?? "chat")}, ${lit(args.title === undefined ? "Hi" : args.title)},
    ${lit(JSON.stringify(args.rows))}::jsonb, ${lit(args.summary ?? null)})`, role);
}

/** Runs SQL in its own session without waiting: the concurrent writer. */
function background(text: string): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", text]);
    let err = "";
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("close", (code) => resolve({ code, err }));
  });
}

/** Waits until a session is blocked on a lock, or fails after five seconds. */
async function untilWaiting(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (Number(must("select count(*) from pg_stat_activity where wait_event_type = 'Lock'")) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no session ever waited on a lock");
}

const count = (table: string) => Number(must(`select count(*) from public.${table}`));

describe.skipIf(!HAS_PG)("coach_save_turn on Postgres (W088)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "coach-save-turn-"));
    port = 54_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-locale", "-E", "UTF8"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr);
    must(PRELUDE);
    must(readFileSync(FILE, "utf8"));
  });

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { must("truncate public.coach_messages, public.coach_threads"); });

  it("creates the thread and saves the turn together, and touches the thread", () => {
    const r = save({ rows: [rowJson(Q, "user", 1), rowJson(R, "assistant", 2)], summary: "sum" });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual([{ id: Q, seq: 1 }, { id: R, seq: 2 }]);
    expect(must(`select user_id, kind, title, summary, last_message_at is not null from public.coach_threads`))
      .toBe(`${A}|chat|Hi|sum|t`);
    expect(must("select role || ':' || seq from public.coach_messages order by seq")).toBe("user:1\nassistant:2");
  });

  it("leaves no empty thread and no half turn when a row is refused mid-call", () => {
    const r = save({ rows: [rowJson(Q, "user", 1), rowJson(R, "assistant", 2, { content: "boom" })] });
    expect(r.ok).toBe(false);
    expect(r.err).toContain("forced failure");
    expect(count("coach_threads")).toBe(0);
    expect(count("coach_messages")).toBe(0);
  });

  it("clamps a summary past the column's 600 characters instead of failing the turn", () => {
    expect(save({ rows: [rowJson(Q, "user", 1)], summary: "s".repeat(700) }).err).toBe("");
    expect(must("select length(summary) from public.coach_threads")).toBe("600");
  });

  it("leaves nothing when the chat cap refuses the new thread", () => {
    must(`insert into public.coach_threads (user_id, kind) select '${A}', 'chat' from generate_series(1, 8)`);
    const r = save({ rows: [rowJson(Q, "user", 1)] });
    expect(r.err).toContain("coach_chat_limit");
    expect(count("coach_threads")).toBe(8);
    expect(count("coach_messages")).toBe(0);
    // A plan thread is outside the cap.
    expect(save({ kind: "plan", rows: [rowJson(Q, "user", 1)] }).ok).toBe(true);
  });

  it("saves after the thread's last seq when another writer took one of the seqs", () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    must(`insert into public.coach_messages (thread_id, user_id, role, seq) values ('${T1}', '${A}', 'assistant', 6)`);
    const r = save({ title: null, rows: [rowJson(Q, "user", 5), rowJson(R, "assistant", 6)] });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual([{ id: Q, seq: 7 }, { id: R, seq: 8 }]);
    // The first attempt's question at 5 was rolled back with it.
    expect(must("select seq from public.coach_messages order by seq")).toBe("6\n7\n8");
  });

  it("appends after the thread's last seq, never into a gap below it, whatever seq the caller sent", () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    must(`insert into public.coach_messages (thread_id, user_id, role, seq) values ('${T1}', '${A}', 'assistant', 10)`);
    const r = save({ title: null, rows: [rowJson(Q, "user", 5), rowJson(R, "assistant", 6)] });
    expect(JSON.parse(r.out)).toEqual([{ id: Q, seq: 11 }, { id: R, seq: 12 }]);
  });

  it("lets a direct insert holding the next seq finish, then saves after it, with no deadlock", async () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    // The weekly review's shape: a direct insert at the next seq, its transaction still open.
    const direct = background(`begin;
      insert into public.coach_messages (thread_id, user_id, role, seq) values ('${T1}', '${A}', 'assistant', 1);
      select pg_sleep(1); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The save locks the thread, reads seq 1 as free (the insert is not committed), and waits on it.
    const saved = background(`select public.coach_save_turn('${A}', '${T1}', 'chat', null,
      '${JSON.stringify([rowJson(Q, "user", 1), rowJson(R, "assistant", 2)])}'::jsonb, null)`);
    const [first, second] = await Promise.all([direct, saved]);
    expect(first).toEqual({ code: 0, err: "" });
    expect(second).toEqual({ code: 0, err: "" });
    expect(must("select role || ':' || seq from public.coach_messages order by seq"))
      .toBe("assistant:1\nuser:2\nassistant:3");
  });

  it("does not deadlock when a direct insert takes the seq while the save holds the thread (Sol BLOCK)", async () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    // The save locks the thread, reads seq 1, then pauses before its row takes seq 1.
    const saved = background(`select public.coach_save_turn('${A}', '${T1}', 'chat', null,
      '${JSON.stringify([rowJson(Q, "user", 1, { content: "slow" })])}'::jsonb, null)`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A direct insert takes seq 1 first; its foreign-key check then needs FOR KEY SHARE on the
    // thread. Under FOR UPDATE it waits on the save while the save waits on its seq: 40P01.
    const direct = await background(`insert into public.coach_messages (thread_id, user_id, role, seq)
      values ('${T1}', '${A}', 'assistant', 1)`);
    expect(direct).toEqual({ code: 0, err: "" });
    expect(await saved).toEqual({ code: 0, err: "" });
    expect(must("select role || ':' || seq from public.coach_messages order by seq")).toBe("assistant:1\nuser:2");
  });

  it("never blocks a direct insert's foreign-key check while a save holds the thread", async () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    // A save that holds its thread lock for a second before committing.
    const held = background(`begin;
      select public.coach_save_turn('${A}', '${T1}', 'chat', null,
        '${JSON.stringify([rowJson(Q, "user", 1)])}'::jsonb, null);
      select pg_sleep(1); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A direct insert at another seq passes its foreign-key check at once (FOR KEY SHARE).
    const started = Date.now();
    const direct = sql(`insert into public.coach_messages (thread_id, user_id, role, seq)
      values ('${T1}', '${A}', 'assistant', 50)`);
    expect(direct.err).toBe("");
    expect(Date.now() - started).toBeLessThan(700);
    expect(await held).toEqual({ code: 0, err: "" });
  });

  it("makes a direct insert at the seq a save took wait, then refuse as a duplicate seq, never deadlock", async () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    const held = background(`begin;
      select public.coach_save_turn('${A}', '${T1}', 'chat', null,
        '${JSON.stringify([rowJson(Q, "user", 1)])}'::jsonb, null);
      select pg_sleep(1); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const direct = background(`insert into public.coach_messages (thread_id, user_id, role, seq)
      values ('${T1}', '${A}', 'assistant', 1)`);
    await untilWaiting();
    const [save, other] = await Promise.all([held, direct]);
    expect(save).toEqual({ code: 0, err: "" });
    // The direct writer's own retry handles this (lib/server/coach.ts reads the next seq again).
    expect(other.err).toContain("coach_messages_thread_seq");
    expect(other.err).not.toContain("deadlock");
  });

  it("gives up as coach_seq_busy after three conflicts, saving nothing", () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${A}')`);
    const r = save({ title: null, rows: [rowJson(Q, "user", 1, { content: "squat" }),
      rowJson(R, "assistant", 2)] });
    expect(r.err).toContain("coach_seq_busy");
    expect(count("coach_messages")).toBe(0);
  });

  it("refuses a message id that is already saved as coach_message_exists", () => {
    expect(save({ rows: [rowJson(Q, "user", 1)] }).ok).toBe(true);
    const r = save({ title: null, rows: [rowJson(Q, "user", 2)] });
    expect(r.err).toContain("coach_message_exists");
  });

  it("refuses a new thread whose id is taken, and another account's thread", () => {
    must(`insert into public.coach_threads (id, user_id) values ('${T1}', '${B}')`);
    expect(save({ rows: [rowJson(Q, "user", 1)] }).err).toContain("coach_thread_exists");
    expect(save({ title: null, rows: [rowJson(Q, "user", 1)] }).err).toContain("coach_thread_not_found");
    expect(save({ title: null, thread: T2, rows: [rowJson(Q, "user", 1, {}, A, T2)] }).err)
      .toContain("coach_thread_not_found");
    expect(count("coach_messages")).toBe(0);
  });

  it("refuses rows that are not one turn of this account and thread", () => {
    const bad: Record<string, unknown>[][] = [
      [],
      [rowJson(R, "assistant", 1)],
      [rowJson(Q, "user", 1, {}, B)],
      [rowJson(Q, "user", 1, {}, A, T2)],
      [rowJson(Q, "user", 1, { model_id: "m" })],
      [rowJson(Q, "user", 1, { tool_calls: { actions: [] } })],
      [rowJson(Q, "user", 1), { ...rowJson(R, "assistant", 2), role: undefined }],
    ];
    for (const rows of bad) expect(save({ rows }).err).toContain("coach_turn_invalid");
    expect(count("coach_threads")).toBe(0);
    // A question carrying its attachments is the user's own shape.
    expect(save({ rows: [rowJson(Q, "user", 1, { tool_calls: { attachments: [] } })] }).ok).toBe(true);
  });

  it("is the service role's alone", () => {
    for (const role of ["authenticated", "anon"]) {
      expect(save({ rows: [rowJson(Q, "user", 1)] }, role).err).toContain("permission denied");
    }
  });
});
