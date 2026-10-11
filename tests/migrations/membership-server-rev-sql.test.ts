/**
 * W029 on a real, throwaway Postgres (audit 2026-10-10 A140, A038): initdb into a temp dir, a
 * prelude that stands in for the Supabase pieces (auth.uid() from the JWT claim, the roles and the
 * owner tables), then the real migration files: the 5-argument set_food_membership body
 * (20261205090000), the Favor functions (20261215090000) and W029's two migrations.
 *
 * - The server assigns a membership revision: a tap whose revision is not above the stored one
 *   (another device's clock ran ahead, or two tabs minted one revision) still writes, and the last
 *   to arrive wins. A retried op id answers its first result and never writes again.
 * - The phone may read its own marks, never another account's, and never the op ledger.
 * - A second Favor writes the `eats` pref of a ref minted after the first Favor.
 *
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const MIGRATIONS = [
  "20261205090000_food_membership_result.sql",
  "20261215090000_favor_food_families.sql",
  "20261231110000_food_membership_server_rev.sql",
  "20261231110100_favor_fill_missing_refs.sql",
];

const PRELUDE = String.raw`
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
  end if;
end $roles$;
create extension if not exists pgcrypto;
create extension if not exists unaccent;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant usage on schema public to authenticated;
grant execute on function auth.uid() to authenticated;
create function food_name_norm(p_name text) returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(lower(public.unaccent(split_part(coalesce(p_name, ''), ',', 1))), '\s+', ' ', 'g')) $$;
create function _sync_assert_caller(p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = public as $$
declare v_caller uuid := auth.uid();
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  if v_caller is not null and v_caller <> p_user_id then raise exception 'forbidden' using errcode = '42501'; end if;
end; $$;
create table user_foods (id uuid primary key default gen_random_uuid(), user_id uuid, name text,
  kind text default 'custom', note text, deleted_at timestamptz);
create table catalog_food_revisions (id bigserial primary key, catalog_food_id bigint, description text,
  is_active boolean default true, valid_from timestamptz default now());
create table food_refs (id uuid primary key default gen_random_uuid(), kind text, catalog_food_id bigint,
  user_food_id uuid);
create unique index on food_refs (catalog_food_id) where catalog_food_id is not null;
create unique index on food_refs (user_food_id) where user_food_id is not null;
create table user_food_prefs (user_id uuid, food_ref_id uuid, status text, note text, role text,
  no_cook boolean, rev int not null default 1, updated_at timestamptz default now(),
  primary key (user_id, food_ref_id));
create table food_membership_revisions (user_id uuid not null references auth.users(id), name_norm text not null,
  status text, note text, rev bigint not null check (rev >= 0), updated_at timestamptz not null default now(),
  primary key (user_id, name_norm));
alter table food_membership_revisions enable row level security;
create table food_note_authority (user_id uuid, name_norm text, note text, primary key (user_id, name_norm));
create table account_rules_clock (user_id uuid primary key, rules_rev bigint not null default 0);
create table evidence_clock (id int primary key, evidence_rev bigint not null);
insert into evidence_clock values (1, 5);
insert into auth.users values ('${A}'), ('${B}');
`;

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);

function sql(text: string, user?: string): { out: string; err: string; ok: boolean } {
  const wrapped = user
    ? `begin; set local role authenticated; set local request.jwt.claim.sub = '${user}';\n${text};\ncommit;`
    : text;
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", wrapped], { encoding: "utf8" });
  return { out: r.stdout.trim(), err: r.stderr.trim(), ok: r.status === 0 };
}

function must(text: string, user?: string): string {
  const r = sql(text, user);
  if (!r.ok) throw new Error(r.err);
  return r.out.split("\n").pop() ?? "";
}

/** One sync op as the route sends it, as `user`; the function's answer. */
function mark(name: string, status: string | null, rev: number, opId: string = crypto.randomUUID(),
  user = A): Record<string, unknown> {
  const s = status === null ? "null" : `'${status}'`;
  return JSON.parse(must(`select set_food_membership('${user}', '${name}', ${s}, null, ${rev}, '${opId}')`, user));
}

const markOf = (name: string, user = A) =>
  must(`select coalesce((select status || '@' || rev from food_membership_revisions
    where user_id = '${user}' and name_norm = '${name}'), 'none')`);

function userFood(user: string, name: string): string {
  const food = must(`insert into user_foods (user_id, name) values ('${user}', '${name}') returning id`);
  return must(`insert into food_refs (kind, user_food_id) values ('user', '${food}') returning id`);
}

describe.skipIf(!HAS_PG)("W029 membership revisions and Favor on Postgres", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "w029-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), PRELUDE);
    for (const file of [path.join(dir, "prelude.sql"),
      ...MIGRATIONS.map((name) => path.join(process.cwd(), "supabase/migrations", name))]) {
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
    must(`truncate food_membership_ops, food_membership_revisions, user_food_prefs, food_refs, user_foods,
      account_rules_clock`);
  });

  it("a tap below a clock-skewed revision still writes: the server assigns the next revision", () => {
    // Device A's clock ran an hour ahead; device B taps Avoid ten minutes later with an honest hint.
    expect(mark("peanut butter", "eats", 1_800_003_600_000)).toMatchObject({ status: "eats",
      rev: 1_800_003_600_000, duplicate: false });
    expect(mark("peanut butter", "avoid", 1_800_000_600_000)).toMatchObject({ status: "avoid",
      rev: 1_800_003_600_001, duplicate: false });
    expect(markOf("peanut butter")).toBe("avoid@1800003600001");
  });

  it("two tabs that minted one revision both write, the later one wins", () => {
    expect(mark("rice", "eats", 7)).toMatchObject({ status: "eats", rev: 7 });
    expect(mark("rice", "avoid", 7)).toMatchObject({ status: "avoid", rev: 8 });
    expect(markOf("rice")).toBe("avoid@8");
  });

  it("a retried op answers its first result and never writes over a later choice", () => {
    const first = crypto.randomUUID();
    expect(mark("kiwi", "eats", 1, first)).toMatchObject({ status: "eats", rev: 1, duplicate: false });
    expect(mark("kiwi", "avoid", 2)).toMatchObject({ status: "avoid", rev: 2 });
    expect(mark("kiwi", "eats", 1, first)).toMatchObject({ status: "eats", rev: 1, duplicate: true });
    expect(markOf("kiwi")).toBe("avoid@2");
  });

  it("refuses another account, and another account's op id", () => {
    const opId = crypto.randomUUID();
    mark("fig", "eats", 1, opId, B);
    expect(sql(`select set_food_membership('${B}', 'fig', 'avoid', null, 5, '${crypto.randomUUID()}')`, A).err)
      .toContain("forbidden");
    expect(sql(`select set_food_membership('${A}', 'fig', 'avoid', null, 5, '${opId}')`, A).err).toContain("forbidden");
    expect(markOf("fig", B)).toBe("eats@1");
    expect(markOf("fig", A)).toBe("none");
  });

  it("the phone reads its own marks only, and never the op ledger", () => {
    mark("kiwi", "eats", 3);
    mark("fig", "avoid", 4, crypto.randomUUID(), B);
    expect(must(`select string_agg(name_norm || ':' || status, ',') from food_membership_revisions`, A))
      .toBe("kiwi:eats");
    expect(sql(`select count(*) from food_membership_ops`, A).err).toContain("permission denied");
    expect(sql(`update food_membership_revisions set status = 'avoid'`, A).ok).toBe(false);
  });

  it("a second Favor writes the eats pref of a ref minted after the first, keeping the mark", () => {
    const gold = userFood(A, "Kiwi, gold");
    const favor = (ids: string[]) => JSON.parse(must(`select favor_food_families('${A}', 'kiwi',
      '${JSON.stringify([{ name_norm: "kiwi", ref_ids: ids }])}'::jsonb,
      array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[],
      (select coalesce(max(rules_rev), 0) from account_rules_clock where user_id = '${A}'), 5)`));
    expect(favor([gold])).toEqual({ status: "ok", favored: ["kiwi"], written: ["kiwi"] });
    const green = userFood(A, "Kiwi, green");
    must(`select get_or_create_food_ref('${A}', 'user', null,
      (select user_food_id from food_refs where id = '${green}'))`);
    const prefs = () => must(`select string_agg(status, ',' order by food_ref_id) from user_food_prefs
      where user_id = '${A}'`);
    expect(prefs()).toBe("eats");
    const ids = [gold, green].sort();
    expect(favor(ids)).toEqual({ status: "ok", favored: ["kiwi"], written: ["kiwi"] });
    expect(prefs()).toBe("eats,eats");
    expect(markOf("kiwi")).toBe("eats@1");
    // Every ref now carries the mark: favored, nothing written.
    expect(favor(ids)).toEqual({ status: "ok", favored: ["kiwi"], written: [] });
  });
});
