/**
 * W008 (audit 2026-10-10): `account_minimum` had no writer, so 20261231150000 / 150001 drop it from
 * target_profiles.kcal_min_source. Static checks on the SQL text, then the two steps on a real,
 * throwaway Postgres: initdb into a temp dir, a stand-in target_profiles carrying the CHECK exactly
 * as 20261029090000_rate_goals.sql wrote it, then the migrations and their down files.
 *
 * Needs the Postgres server binaries (PG_BIN, default Homebrew postgresql@16); skipped without
 * them. It never connects to any Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KCAL_MIN_SOURCES } from "@/lib/types";

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const STEP1 = path.join(MIGRATIONS, "20261231150000_drop_account_minimum.sql");
const STEP2 = path.join(MIGRATIONS, "20261231150001_drop_account_minimum_validate.sql");
const DOWN1 = path.join(MIGRATIONS, "down/20261231150000_drop_account_minimum.down.sql");
const DOWN2 = path.join(MIGRATIONS, "down/20261231150001_drop_account_minimum_validate.down.sql");

// The column and CHECK exactly as 20261029090000_rate_goals.sql added them.
const PRELUDE = `
create table public.target_profiles (id serial primary key);
alter table public.target_profiles
  add column kcal_min_source text not null default 'legacy_default'
    constraint target_profiles_kcal_min_source_check
    check (kcal_min_source in ('macro_minimum', 'account_minimum', 'legacy_default'));
`;

let dir = "";
let port = 0;
const bin = (name: string) => path.join(PG_BIN, name);
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

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
function apply(file: string): { ok: boolean; err: string } {
  const r = spawnSync(bin("psql"), ["-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
  return { ok: r.status === 0, err: r.stderr };
}
function mustApply(file: string): void {
  const r = apply(file);
  if (!r.ok) throw new Error(`${file}: ${r.err}`);
}
const insert = (source: string) =>
  sql(`insert into public.target_profiles (kcal_min_source) values ('${source}')`);

describe("account_minimum is gone (W008)", () => {
  it("the app's sources name only the two labels a writer sets", () => {
    expect([...KCAL_MIN_SOURCES]).toEqual(["macro_minimum", "legacy_default"]);
  });

  it("step 1 refuses on account_minimum rows, adds the CHECK not valid; step 2 validates", () => {
    const up = readFileSync(STEP1, "utf8");
    expect(up).toMatch(/set local lock_timeout = '3s'/);
    expect(up).toMatch(/raise exception '20261231150000_drop_account_minimum/);
    expect(up).toMatch(/check \(kcal_min_source in \('macro_minimum', 'legacy_default'\)\) not valid;/);
    expect(readFileSync(STEP2, "utf8"))
      .toMatch(/validate constraint target_profiles_kcal_min_source_check/);
    expect(readFileSync(DOWN1, "utf8")).toMatch(/'macro_minimum', 'account_minimum', 'legacy_default'/);
  });
});

describe.skipIf(!HAS_PG)("20261231150000 / 150001 drop account_minimum (database)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "account-min-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + readFileSync(path.join(dir, "log"), "utf8"));
    writeFileSync(path.join(dir, "prelude.sql"), PRELUDE);
    mustApply(path.join(dir, "prelude.sql"));
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("before W008 the table takes an account_minimum row (the unused label)", () => {
    expect(insert("account_minimum").ok).toBe(true);
  });

  it("step 1 refuses, writing nothing, while an account_minimum row exists", () => {
    const refused = apply(STEP1);
    expect(refused.ok).toBe(false);
    expect(refused.err).toMatch(/holds account_minimum rows/);
    expect(insert("account_minimum").ok).toBe(true);
    must(`delete from public.target_profiles`);
  });

  it("after both steps only macro_minimum and legacy_default are accepted", () => {
    must(`insert into public.target_profiles (kcal_min_source) values ('macro_minimum'), ('legacy_default')`);
    mustApply(STEP1);
    mustApply(STEP2);
    expect(must(`select convalidated from pg_constraint where conname = 'target_profiles_kcal_min_source_check'`))
      .toBe("t");
    const refused = insert("account_minimum");
    expect(refused.ok).toBe(false);
    expect(refused.err).toMatch(/target_profiles_kcal_min_source_check/);
    expect(insert("macro_minimum").ok).toBe(true);
    expect(insert("legacy_default").ok).toBe(true);
  });

  it("the down files put back the three-value CHECK, and the up files re-apply", () => {
    mustApply(DOWN2);
    mustApply(DOWN1);
    expect(insert("account_minimum").ok).toBe(true);
    must(`delete from public.target_profiles where kcal_min_source = 'account_minimum'`);
    mustApply(STEP1);
    mustApply(STEP2);
    expect(insert("account_minimum").ok).toBe(false);
  });
});
