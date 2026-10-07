/**
 * Phase 18 W4, migration 3 (spec §6 row 3): `catalog_food_inputs`. The text half runs in every unit
 * shard; the database half runs on the migrated local stack (SUPABASE_TEST_DB_URL, the CI
 * Integration job), every write inside a transaction that is rolled back. Production is applied by
 * the owner, with a backup; nothing here can reach it (tests/tenancy/local-only).
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const UP = read("supabase/migrations/20261214100000_catalog_food_inputs.sql");
const VALIDATE = read("supabase/migrations/20261214100100_catalog_food_inputs_validate.sql");
const DOWN = read("supabase/migrations/down/20261214100000_catalog_food_inputs.down.sql");
const REPLACE = read("supabase/migrations/20261214100200_catalog_replace_food_inputs.sql");
const code = (sql: string) => sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("20261214100000 / 20261214100100 catalog_food_inputs (text)", () => {
  it("is live-safe: lock and statement timeouts, constant defaults, constraints NOT VALID then validated", () => {
    for (const file of [UP, VALIDATE, DOWN]) {
      expect(file).toContain("set local lock_timeout = '3s';");
      expect(file).toContain("set local statement_timeout = '30s';");
    }
    expect(code(UP)).toContain("source text not null default 'fndds'");
    expect(code(UP)).toContain("estimated boolean not null default true");
    const added = [...code(UP).matchAll(/add constraint (\w+)[\s\S]*?;/g)];
    expect(added.map((m) => m[1]).sort()).toEqual(["catalog_food_inputs_grams", "catalog_food_inputs_input_fk",
      "catalog_food_inputs_revision_fk", "catalog_food_inputs_seq", "catalog_food_inputs_source"]);
    for (const m of added) expect(m[0]).toMatch(/not valid;$/);
    for (const m of added) expect(code(VALIDATE)).toContain(`validate constraint ${m[1]};`);
    expect(code(VALIDATE)).not.toMatch(/\b(create|drop|insert|update|delete)\b/i);
  });

  it("accepts only the fndds source: no jev source exists", () => {
    expect(code(UP)).toContain("check (source in ('fndds'))");
    expect(code(UP)).not.toMatch(/jev/i);
  });

  it("is a catalog table: forced RLS, one authenticated read policy, writes for service_role only", () => {
    expect(code(UP)).toContain("force row level security");
    expect(code(UP)).toContain("for select to authenticated using (true)");
    expect(code(UP)).toContain("revoke all on table public.catalog_food_inputs from public, anon, authenticated");
    expect(code(UP)).toContain("grant all on table public.catalog_food_inputs to service_role");
    expect(code(UP)).toContain("references public.catalog_food_revisions(id) on delete cascade");
  });

  it("the replace function is security invoker, service_role only, delete and insert in one call", () => {
    expect(REPLACE).toContain("set local lock_timeout = '3s';");
    expect(code(REPLACE)).toMatch(/r\.is_active\s+for share/);
    expect(code(REPLACE)).toContain("security invoker");
    expect(code(REPLACE)).toContain("revoke all on function public.catalog_replace_food_inputs(bigint[], jsonb) from public, anon, authenticated");
    expect(code(REPLACE)).toContain("grant execute on function public.catalog_replace_food_inputs(bigint[], jsonb) to service_role");
    expect(code(REPLACE).indexOf("delete from public.catalog_food_inputs")).toBeLessThan(
      code(REPLACE).indexOf("insert into public.catalog_food_inputs"));
  });

  it("the down file drops only its own table", () => {
    expect(code(DOWN)).toMatch(/^\s*drop table if exists public\.catalog_food_inputs;\s*$/m);
    expect(code(DOWN).match(/\bdrop\b/g)).toHaveLength(1);
  });
});

/** Minimal catalog rows for one dish and one input, inside the caller's transaction. */
const FIXTURE = `
  insert into catalog_versions (source, version_label) values ('fdc_fndds', 'w4-test'), ('fdc_sr_legacy', 'w4-test');
  insert into catalog_foods (source, source_id) values ('fdc_fndds', 'w4-dish'), ('fdc_sr_legacy', 'w4-input');
  insert into catalog_food_revisions (description, catalog_food_id, catalog_version_id, quality_class, content_hash, is_active)
    select 'W4 dish', f.id, v.id, 'survey', 'w4', true from catalog_foods f
      join catalog_versions v on v.source = f.source and v.version_label = 'w4-test' where f.source_id = 'w4-dish';
  create temp table w4 on commit drop as select
    (select r.id from catalog_food_revisions r join catalog_foods f on f.id = r.catalog_food_id where f.source_id = 'w4-dish') as rev,
    (select id from catalog_foods where source_id = 'w4-input') as input;
  grant select on w4 to authenticated, anon, service_role;`;
const insert = (grams: string) => `insert into catalog_food_inputs (food_revision_id, seq, input_catalog_food_id, grams)
  select rev, 1, input, ${grams} from w4;`;
/** Runs `sql` after the fixture and rolls everything back; returns the last line of output. */
const tx = (sql: string) => runSql(`begin; ${FIXTURE} ${sql} rollback;`).split("\n")
  .filter((line) => line !== "ROLLBACK").pop() ?? "";

describe.skipIf(!HAS_DB)("catalog_food_inputs on the migrated schema", () => {
  it("has every constraint validated and RLS forced", () => {
    expect(runSql(`select string_agg(conname || ':' || convalidated, ',' order by conname) from pg_constraint
      where conrelid = 'public.catalog_food_inputs'::regclass`)).toBe("catalog_food_inputs_grams:true,"
      + "catalog_food_inputs_input_fk:true,catalog_food_inputs_pkey:true,catalog_food_inputs_revision_fk:true,"
      + "catalog_food_inputs_seq:true,catalog_food_inputs_source:true");
    expect(runSql(`select relrowsecurity::text || relforcerowsecurity::text from pg_class
      where oid = 'public.catalog_food_inputs'::regclass`)).toBe("truetrue");
  });

  it("stores a row with the fndds source, estimated, and refuses jev, zero grams and a missing food", () => {
    expect(tx(`${insert("40")} select source || ':' || estimated from catalog_food_inputs, w4 where food_revision_id = w4.rev;`))
      .toBe("fndds:true");
    expect(() => tx(`insert into catalog_food_inputs (food_revision_id, seq, input_catalog_food_id, grams, source)
      select rev, 1, input, 40, 'jev' from w4;`)).toThrow(/catalog_food_inputs_source/);
    expect(() => tx(insert("0"))).toThrow(/catalog_food_inputs_grams/);
    expect(() => tx(`insert into catalog_food_inputs (food_revision_id, seq, input_catalog_food_id, grams)
      select rev, 1, -1, 40 from w4;`)).toThrow(/catalog_food_inputs_input_fk/);
  });

  it("goes with its dish revision (on delete cascade)", () => {
    expect(tx(`${insert("40")} delete from catalog_food_revisions where id = (select rev from w4);
      select count(*) from catalog_food_inputs, w4 where food_revision_id = w4.rev;`)).toBe("0");
  });

  it("is readable by authenticated, writable by service_role only, invisible to anon", () => {
    expect(tx(`${insert("40")} set local role authenticated;
      select count(*) from catalog_food_inputs, w4 where food_revision_id = w4.rev;`)).toBe("1");
    expect(() => tx(`set local role authenticated; ${insert("40")}`))
      .toThrow(/permission denied for table catalog_food_inputs/);
    expect(() => tx(`set local role anon; select count(*) from catalog_food_inputs;`))
      .toThrow(/permission denied for table catalog_food_inputs/);
    expect(tx(`set local role service_role; ${insert("40")} select 'ok';`)).toBe("ok");
  });

  it("round-trips: the down file drops it and the two up files recreate it", () => {
    expect(runSql(`begin; ${DOWN} select coalesce(to_regclass('public.catalog_food_inputs')::text, 'gone'); ${UP} ${VALIDATE}
      select to_regclass('public.catalog_food_inputs')::text; rollback;`)).toMatch(/gone[\s\S]*catalog_food_inputs/);
  });

  const call = (rows: string) => `select catalog_replace_food_inputs(array[(select rev from w4)], jsonb_build_array(${rows}));`;
  const item = (seq: number, grams: number, rev = "(select rev from w4)") =>
    `jsonb_build_object('food_revision_id', ${rev}, 'seq', ${seq}, 'input_catalog_food_id', (select input from w4), `
    + `'grams', ${grams}, 'source', 'fndds', 'estimated', true)`;
  const stored = "select string_agg(seq || ':' || grams, ',' order by seq) from catalog_food_inputs, w4 where food_revision_id = w4.rev;";
  const old = `insert into catalog_food_inputs (food_revision_id, seq, input_catalog_food_id, grams)
    select rev, s, input, 7 from w4, generate_series(1, 3) s;`;

  it("catalog_replace_food_inputs replaces a dish's rows in one transaction", () => {
    expect(tx(`${old} ${call(`${item(1, 5)}, ${item(2, 6)}`)} ${stored}`)).toBe("1:5,2:6");
  });

  it("a failure mid-dish leaves the dish fully old (atomic)", () => {
    const failing = `do $$ begin perform catalog_replace_food_inputs(array[(select rev from w4)],
      jsonb_build_array(${item(1, 5)}, ${item(2, 0)})); exception when check_violation then null; end $$;`;
    expect(tx(`${old} ${failing} ${stored}`)).toBe("1:7,2:7,3:7");
  });

  it("refuses a row outside the named revisions, and is not executable by authenticated", () => {
    expect(() => tx(`${old} ${call(item(1, 5, "-1"))}`)).toThrow(/outside the batch/);
    expect(() => tx(`set local role authenticated; ${call(item(1, 5))}`))
      .toThrow(/permission denied for function catalog_replace_food_inputs/);
  });

  it("refuses, writing nothing, when a named revision was deactivated after the preflight (Sol W4 r2 WARN 3)", () => {
    const deactivate = "update catalog_food_revisions set is_active = false where id = (select rev from w4);";
    expect(() => tx(`${old} ${deactivate} ${call(item(1, 5))}`)).toThrow(/named revisions are not active/);
    const swallowed = `do $$ begin perform catalog_replace_food_inputs(array[(select rev from w4)],
      jsonb_build_array(${item(1, 5)})); exception when object_not_in_prerequisite_state then null; end $$;`;
    expect(tx(`${old} ${deactivate} ${swallowed} ${stored}`)).toBe("1:7,2:7,3:7");
  });
});
