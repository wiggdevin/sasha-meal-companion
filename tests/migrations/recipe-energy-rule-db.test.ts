/**
 * W004 (audit 2026-10-10, A008): migration 20261230090400_recipe_energy_rule makes the recipe sum
 * in _sync_upsert apply the one energy rule per ingredient, and this proves it agrees with the TS
 * twins — `itemKcal` (lib/nutrients/energy.ts) and `computeRecipeNutrients`
 * (lib/recipes/nutrients.ts) — on the shared fixture tests/fixtures/energy-rule-cases.ts.
 *
 * The database half runs on a real, throwaway Postgres (initdb into a temp dir, the
 * coach-undo-sql.test.ts pattern). Its `_sync_upsert` is a stub whose recipe sum is the REAL block
 * cut from the last full definition (20261025090200_log_entries_title.sql), so the migration's
 * anchor patch is applied to the text production runs. Needs the Postgres server binaries
 * (PG_BIN, default Homebrew postgresql@16); skipped without them. It never connects to any
 * Supabase project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { itemKcal } from "@/lib/nutrients/energy";
import { computeRecipeNutrients, type Per100gByRef, type RecipeItemInput } from "@/lib/recipes/nutrients";
import { ENERGY_RULE_CASES, MEASURED_MACROS } from "@/tests/fixtures/energy-rule-cases";

const NAME = "20261230090400_recipe_energy_rule";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const UP_FILE = path.join(MIGRATIONS, `${NAME}.sql`);
const DOWN_FILE = path.join(MIGRATIONS, "down", `${NAME}.down.sql`);
const LAST_FULL = "20261025090200_log_entries_title.sql";
const BLOCK_START = "      with per_item as (";
const BLOCK_END = "into v_per_serving, v_coverage;";

const read = (file: string) => readFileSync(file, "utf8");

/** The recipe sum exactly as the last full _sync_upsert definition writes it. */
function realRecipeBlock(): string {
  const text = read(path.join(MIGRATIONS, LAST_FULL));
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) throw new Error(`recipe block not found in ${LAST_FULL}`);
  return text.slice(start, end + BLOCK_END.length);
}

describe(`${NAME}.sql (static)`, () => {
  it("is the last full _sync_upsert definition the patch anchors on, and no later file touches it", () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f > LAST_FULL && f !== `${NAME}.sql`);
    for (const file of later) {
      const text = read(path.join(MIGRATIONS, file));
      expect(text, file).not.toMatch(/create or replace function (public\.)?_sync_upsert/);
      expect(text, file).not.toContain("per_item");
    }
    const anchor = "from per_item cross join lateral jsonb_each(per_item.snap) kv),";
    expect(realRecipeBlock().split(anchor).length - 1).toBe(1);
  });

  it("patches by anchor, refuses a partial patch, and re-grants only service_role", () => {
    const up = read(UP_FILE);
    expect(up).toContain("anchor % occurs % times, expected once");
    expect(up).toContain("refusing a partial function");
    expect(up).toContain("revoke all on function public._snapshot_energy_kcal(jsonb) from public, anon, authenticated;");
    expect(up).not.toMatch(/grant [^;]* to (authenticated|anon)/);
    expect(read(DOWN_FILE)).toContain("drop function if exists public._snapshot_energy_kcal(jsonb);");
  });
});

const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const HAS_PG = existsSync(path.join(PG_BIN, "initdb")) && existsSync(path.join(PG_BIN, "psql"));
/** A C locale: on macOS a UTF-8 locale makes the postmaster multithreaded at startup, and it exits. */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

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
const lit = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

const ref = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A fixture case as the database stores an item's per-100 g snapshot. */
function snapOf(snapshot: Record<string, { amount: unknown }>): Record<string, { amount: unknown }> {
  const macros = Object.fromEntries(Object.entries(MEASURED_MACROS).map(([k, v]) => [k, { amount: v }]));
  return { ...macros, ...snapshot };
}

/** The same case as computeRecipeNutrients reads it. */
function per100Of(snapshot: Record<string, { amount: unknown }>): Record<NutrientCode, number | null> {
  return Object.fromEntries(Object.entries(snapOf(snapshot)).map(([k, v]) => [k, v.amount])) as
    Record<NutrientCode, number | null>;
}

/** Recipe revision `revision` over fixture cases `indexes` at `grams` each, from the stub. */
function serverRecipe(revision: number, servings: number): { energy: number | null; coverage: number } {
  const out = JSON.parse(sql(`select public._sync_upsert(null, 'recipes', null,
    ${lit({ revision, servings })}, 1);`)) as Record<string, number | null>;
  return { energy: out.energy_kcal ?? null, coverage: Number(out.coverage) };
}

function clientRecipe(indexes: number[], grams: number, servings: number) {
  const items: RecipeItemInput[] = indexes.map((i, seq) => ({ seq: seq + 1, foodRefId: ref(i),
    qty: grams, unit: "g", grams, state: "raw" }));
  const per100g: Per100gByRef = Object.fromEntries(indexes.map((i) => [ref(i),
    per100Of(ENERGY_RULE_CASES[i].snapshot)]));
  const result = computeRecipeNutrients(items, per100g, servings);
  return { energy: result.perServing.energy_kcal ?? null, coverage: result.coverage };
}

describe.skipIf(!HAS_PG)(`${NAME}.sql on a throwaway Postgres`, () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "recipe-energy-pg-"));
    port = 55_000 + Math.floor(Math.random() * 1_000);
    const init = spawnSync(bin("initdb"), ["-D", path.join(dir, "data"), "-U", "postgres", "-A", "trust",
      "--no-sync"], { encoding: "utf8", env: PG_ENV });
    if (init.status !== 0) throw new Error(init.stderr);
    const start = spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "log"),
      "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { encoding: "utf8", env: PG_ENV });
    if (start.status !== 0) throw new Error(start.stderr + read(path.join(dir, "log")));
    // Stand-ins for the Supabase pieces the recipe sum reads: the roles, the items, and
    // compute_item_snapshot (per-100 g amounts × grams ÷ 100, rounded to 4 like the real one).
    const prelude = `
      create role anon nologin; create role authenticated nologin; create role service_role nologin;
      create table recipe_items (recipe_revision_id bigint, food_ref_id uuid, grams numeric);
      create table test_snaps (ref uuid primary key, snap jsonb not null);
      create function public.compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
      returns jsonb language sql stable as $f$
        select coalesce(jsonb_object_agg(kv.key, case
                 when jsonb_typeof(kv.value->'amount') = 'number'
                   then jsonb_build_object('amount', round((kv.value->>'amount')::numeric * p_grams / 100, 4))
                 else kv.value end), '{}'::jsonb)
          from test_snaps s cross join lateral jsonb_each(s.snap) kv where s.ref = p_food_ref_id
      $f$;
      create function public._sync_upsert(p_user_id uuid, p_entity text, p_key text, p_payload jsonb,
                                          p_rev integer)
      returns jsonb language plpgsql security definer set search_path = public as $stub$
      declare
        v_revision_id bigint := (p_payload->>'revision')::bigint;
        v_items integer;
        v_servings numeric := (p_payload->>'servings')::numeric;
        v_per_serving jsonb;
        v_coverage numeric;
      begin
        select count(*) into v_items from recipe_items where recipe_revision_id = v_revision_id;
${realRecipeBlock()}
        return v_per_serving || jsonb_build_object('coverage', v_coverage);
      end
      $stub$;`;
    writeFileSync(path.join(dir, "prelude.sql"), prelude);
    runFile(path.join(dir, "prelude.sql"));
    const snaps = ENERGY_RULE_CASES.map((c, i) => `('${ref(i)}', ${lit(snapOf(c.snapshot))})`);
    sql(`insert into test_snaps values ${snaps.join(", ")};`);
    // Revision 1: the whole fixture at 150 g each. Revision 10 + i: case i alone at 100 g.
    const whole = ENERGY_RULE_CASES.map((_, i) => `(1, '${ref(i)}', 150)`);
    const alone = ENERGY_RULE_CASES.map((_, i) => `(${10 + i}, '${ref(i)}', 100)`);
    sql(`insert into recipe_items values ${[...whole, ...alone].join(", ")};`);
  }, 60_000);

  afterAll(() => {
    if (!dir) return;
    spawnSync(bin("pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("before the migration, the per-code sum drops a calculated-only ingredient (the defect)", () => {
    const calcOnly = ENERGY_RULE_CASES.findIndex((c) => c.name.startsWith("calculated only"));
    expect(serverRecipe(10 + calcOnly, 1).energy).toBeNull();
  });

  it("applies, and a second run is a no-op", () => {
    runFile(UP_FILE);
    runFile(UP_FILE);
    expect(sql(`select count(*) from pg_proc where proname = '_snapshot_energy_kcal';`)).toBe("1");
  });

  it.each(ENERGY_RULE_CASES.map((c, i) => [c.name, i] as const))(
    "_snapshot_energy_kcal agrees with itemKcal: %s", (_name, i) => {
      const { snapshot, kcal } = ENERGY_RULE_CASES[i];
      const out = sql(`select public._snapshot_energy_kcal(${lit(snapshot)});`);
      const value = out === "" ? null : Number(out);
      expect(value).toBe(itemKcal(snapshot));
      expect(value).toBe(kcal);
    });

  it.each(ENERGY_RULE_CASES.map((c, i) => [c.name, i] as const))(
    "a one-ingredient recipe agrees with computeRecipeNutrients: %s", (_name, i) => {
      expect(serverRecipe(10 + i, 1)).toEqual(clientRecipe([i], 100, 1));
    });

  it("the whole fixture as one recipe agrees on energy and coverage", () => {
    const indexes = ENERGY_RULE_CASES.map((_, i) => i);
    const server = serverRecipe(1, 3);
    expect(server).toEqual(clientRecipe(indexes, 150, 3));
    expect(server.coverage).toBe(0.75);
  });

  it("down restores the per-code sum and drops the helper; up applies again", () => {
    runFile(DOWN_FILE);
    expect(sql(`select count(*) from pg_proc where proname = '_snapshot_energy_kcal';`)).toBe("0");
    const calcOnly = ENERGY_RULE_CASES.findIndex((c) => c.name.startsWith("calculated only"));
    expect(serverRecipe(10 + calcOnly, 1).energy).toBeNull();
    runFile(UP_FILE);
    expect(serverRecipe(10 + calcOnly, 1).energy).toBe(80);
  });
});
