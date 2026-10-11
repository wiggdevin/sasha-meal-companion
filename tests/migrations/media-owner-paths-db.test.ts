/**
 * W019 (audit 2026-10-10 A055, P08): migrations 20261230091900 / 20261230091901 on a real,
 * throwaway Postgres. initdb into a temp dir, a prelude that stands in for the Supabase pieces the
 * media migrations touch (auth.uid() from the JWT claim, storage.objects with RLS and
 * storage.foldername, log_entries for the entry_id reference), then the Phase 4 media migration and
 * the two W019 steps. It proves a signed-in user can no longer write to the bucket directly (only
 * read and delete in her own folder), media_objects refuses a path outside the row owner's folder
 * for every writer, the validate step refuses a database that already holds such a row, and the
 * down files put the old shape back.
 *
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const FILE = "3f1b1a2c-0000-4000-8000-000000000030";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const STEP1 = path.join(MIGRATIONS, "20261230091900_media_owner_paths.sql");
const STEP2 = path.join(MIGRATIONS, "20261230091901_media_owner_paths_validate.sql");
const DOWN1 = path.join(MIGRATIONS, "down/20261230091900_media_owner_paths.down.sql");
const DOWN2 = path.join(MIGRATIONS, "down/20261230091901_media_owner_paths_validate.down.sql");

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

const PRELUDE = String.raw`
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
  end if;
end $roles$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
insert into auth.users values ('${A}'), ('${B}');
create table log_entries (id uuid primary key, user_id uuid);
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id bigserial primary key, bucket_id text, name text, owner uuid,
  unique (bucket_id, name));
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant all on storage.objects to authenticated;
grant usage, select on sequence storage.objects_id_seq to authenticated;
`;

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
  return r.out;
}

/** Runs one migration file in a single transaction, as the deploy does. */
function apply(file: string): { ok: boolean; err: string } {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
  return { ok: r.status === 0, err: r.stderr };
}

function mustApply(file: string): void {
  const r = apply(file);
  if (!r.ok) throw new Error(`${file}: ${r.err}`);
}

const media = (owner: string, file = FILE, ext = "jpg") => `media/${owner}/${file}.${ext}`;
const insertRow = (p: string, owner: string, as?: string) =>
  sql(`insert into public.media_objects (path, user_id, kind, bytes) values ('${p}', '${owner}', 'image', 1)`, as);
const putObject = (name: string, as?: string) =>
  sql(`insert into storage.objects (bucket_id, name, owner) values ('media', '${name}', '${as ?? A}')`, as);

describe("20261230091900 / 091901 media owner paths (text)", () => {
  const up = readFileSync(STEP1, "utf8");

  it("leaves authenticated only select and delete on storage.objects, never insert or update", () => {
    expect(up).toMatch(/drop policy if exists media_own_folder on storage\.objects/);
    expect(up).toMatch(/for select to authenticated/);
    expect(up).toMatch(/for delete to authenticated/);
    expect(up).not.toMatch(/for (all|insert|update) to authenticated/);
  });

  it("adds the CHECK not valid with a lock timeout, and validates it in its own step", () => {
    expect(up).toMatch(/set local lock_timeout = '3s'/);
    expect(up).toMatch(/\) not valid;/);
    expect(readFileSync(STEP2, "utf8")).toMatch(/validate constraint media_objects_owner_path/);
  });
});

describe.skipIf(!HAS_PG)("20261230091900 / 091901 media owner paths (database)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "media-paths-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), PRELUDE);
    mustApply(path.join(dir, "prelude.sql"));
    mustApply(path.join(MIGRATIONS, "20260920090100_phase4_media_bucket.sql"));
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("before W019: a signed-in user uploads straight to her folder and may name a foreign path (the defect)", () => {
    expect(putObject(`${A}/${FILE}.jpg`, A).ok).toBe(true);
    expect(insertRow(media(B), A, A).ok).toBe(true);
    must(`delete from storage.objects; delete from public.media_objects`);
  });

  it("the validate step refuses a database that already holds a foreign-path row", () => {
    must(`insert into public.media_objects (path, user_id, kind, bytes) values ('${media(B)}', '${A}', 'image', 1)`);
    mustApply(STEP1);
    const refused = apply(STEP2);
    expect(refused.ok).toBe(false);
    expect(refused.err).toMatch(/media_objects_owner_path/);
    must(`delete from public.media_objects`);
    mustApply(STEP2);
    expect(must(`select convalidated from pg_constraint where conname = 'media_objects_owner_path'`)).toBe("t");
  });

  it("a signed-in user can no longer insert or update bucket objects, even in her own folder (A055)", () => {
    const direct = putObject(`${A}/${crypto.randomUUID()}.jpg`, A);
    expect(direct.ok).toBe(false);
    expect(direct.err).toMatch(/row-level security/);
    // The service role's signed upload still lands (Storage writes it as its own superuser).
    must(`insert into storage.objects (bucket_id, name, owner) values ('media', '${A}/${FILE}.jpg', '${A}'),
      ('media', '${B}/${FILE}.jpg', '${B}')`);
    expect(must(`update storage.objects set name = '${A}/x.jpg' where name = '${A}/${FILE}.jpg' returning 1`, A))
      .toBe("");
    expect(must(`select name from storage.objects where name = '${A}/${FILE}.jpg'`)).toBe(`${A}/${FILE}.jpg`);
  });

  it("she still reads and deletes only in her own folder", () => {
    expect(must(`select name from storage.objects order by name`, A)).toBe(`${A}/${FILE}.jpg`);
    expect(must(`delete from storage.objects where name = '${B}/${FILE}.jpg' returning 1`, A)).toBe("");
    expect(must(`delete from storage.objects where name = '${A}/${FILE}.jpg' returning 1`, A)).toBe("1");
    expect(must(`select count(*) from storage.objects`)).toBe("1");
    must(`delete from storage.objects`);
  });

  it("media_objects takes only media/<owner>/<uuid>.<ext>, for every writer (P08)", () => {
    expect(insertRow(media(A), A, A).ok).toBe(true);
    expect(insertRow(media(A, FILE, "m4a"), A).ok).toBe(true);
    for (const bad of [media(B), `media/${A}/../${B}/${FILE}.jpg`, `${A}/${FILE}.jpg`,
      `media/${A}/tenancy-${FILE}.jpg`, `media/${A}/${FILE}.bin`, `media/${A}/sub/${FILE}.jpg`,
      `media/${A}/${FILE.toUpperCase()}.jpg`]) {
      for (const as of [A, undefined]) {
        const r = insertRow(bad, A, as);
        expect(r.ok, `${bad} as ${as ?? "postgres"}`).toBe(false);
        expect(r.err).toMatch(/media_objects_owner_path/);
      }
    }
    const moved = sql(`update public.media_objects set path = '${media(B)}' where path = '${media(A)}'`, A);
    expect(moved.ok).toBe(false);
    expect(moved.err).toMatch(/media_objects_owner_path/);
    const reowned = sql(`update public.media_objects set user_id = '${B}' where path = '${media(A)}'`);
    expect(reowned.ok).toBe(false);
    must(`delete from public.media_objects`);
  });

  it("the down files put back the Phase 4 policy and drop the CHECK, and the up files re-apply", () => {
    mustApply(DOWN2);
    mustApply(DOWN1);
    expect(must(`select count(*) from pg_constraint where conname = 'media_objects_owner_path'`)).toBe("0");
    expect(putObject(`${A}/${FILE}.jpg`, A).ok).toBe(true);
    must(`delete from storage.objects`);
    mustApply(STEP1);
    mustApply(STEP2);
    expect(putObject(`${A}/${FILE}.jpg`, A).ok).toBe(false);
    expect(must(`select string_agg(policyname, ',' order by policyname) from pg_policies
      where schemaname = 'storage' and tablename = 'objects'`)).toBe("media_own_delete,media_own_read");
  });
});
