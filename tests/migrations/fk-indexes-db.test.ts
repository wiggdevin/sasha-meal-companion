/**
 * W054 + W126, migrations 20270106090000 (foreign-key indexes, CONCURRENTLY) and 20270106090200
 * (pg_trgm and unaccent move to the extensions schema; coach_save_turn refuses a deleted thread).
 * The text half runs in every unit shard; the database half runs on the migrated local stack
 * (SUPABASE_TEST_DB_URL). Nothing here can reach production (tests/tenancy/local-only).
 *
 * Acceptance: no foreign key in public lacks an index whose leading columns are exactly its own
 * (a later migration that adds one without an index fails here); no index is left invalid; both
 * extensions live in `extensions` and the search helpers still unaccent; a turn saved after its
 * thread was deleted is refused as coach_thread_deleted and writes nothing.
 */
import "../tenancy/local-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const INDEXES = read("supabase/migrations/20270106090000_fk_indexes_concurrently.sql");
const INDEXES_DOWN = read("supabase/migrations/down/20270106090000_fk_indexes_concurrently.down.sql");
const UP = read("supabase/migrations/20270106090200_extensions_schema_save_turn_deleted.sql");
const DOWN = read("supabase/migrations/down/20270106090200_extensions_schema_save_turn_deleted.down.sql");
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const statements = (sql: string) => code(sql).split(";").map((s) => s.trim()).filter(Boolean);

/** Foreign keys in public whose columns are not exactly the leading columns of some index. */
const UNINDEXED_FKS = `
  select c.conrelid::regclass || '.' || c.conname
    from pg_constraint c join pg_class r on r.oid = c.conrelid
   where c.contype = 'f' and r.relnamespace = 'public'::regnamespace
     and not exists (
       select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
   order by 1`;

describe("20270106090000 foreign-key indexes (text)", () => {
  it("holds nothing but CREATE INDEX CONCURRENTLY IF NOT EXISTS, outside any transaction", () => {
    const up = statements(INDEXES);
    expect(up.length).toBe(30);
    for (const s of up) expect(s).toMatch(/^create index concurrently if not exists \w+\n {2}on public\.\w+ \([\w, ]+\)$/);
    expect(code(INDEXES)).not.toMatch(/\b(begin|commit|set local)\b/i);
    expect(code(INDEXES)).toContain("on public.recipe_plan_selections (target_revision_id, user_id)");
    expect(code(INDEXES)).toContain("on public.shopping_purchase_windows (line_id, user_id, period_id)");
  });

  it("the down file drops each one concurrently", () => {
    const names = statements(INDEXES).map((s) => s.split(/\s+/)[6]);
    const down = statements(INDEXES_DOWN);
    expect(down).toEqual(names.map((name) => `drop index concurrently if exists public.${name}`));
  });
});

describe("20270106090200 extensions schema and deleted-thread refusal (text)", () => {
  it("moves both extensions and names extensions.unaccent; the down file moves them back", () => {
    expect(code(UP)).toContain("set local lock_timeout = '3s';");
    for (const ext of ["pg_trgm", "unaccent"]) {
      expect(code(UP)).toContain(`    alter extension ${ext} set schema extensions;`);
      expect(code(DOWN)).toContain(`alter extension ${ext} set schema public;`);
    }
    expect(code(UP)).not.toContain("public.unaccent");
    expect(code(UP).match(/extensions\.unaccent\(/g)).toHaveLength(4);
    expect(code(DOWN).match(/public\.unaccent\(/g)).toHaveLength(4);
  });

  it("refuses a deleted thread under the same lock, and keeps the service-role-only grant", () => {
    expect(code(UP)).toContain("select th.user_id, th.deleted_at into v_owner, v_deleted from public.coach_threads th\n   where th.id = p_thread_id for no key update;");
    expect(code(UP)).toContain("raise exception 'coach_thread_deleted'");
    expect(code(DOWN)).not.toContain("coach_thread_deleted");
    for (const file of [UP, DOWN]) {
      expect(code(file)).toContain("revoke all on function public.coach_save_turn(uuid, uuid, text, text, jsonb, text)\n  from public, anon, authenticated;");
      expect(code(file)).toContain("grant execute on function public.coach_save_turn(uuid, uuid, text, text, jsonb, text)\n  to service_role;");
    }
  });
});

describe.skipIf(!HAS_DB)("20270106090000 + 20270106090200 (database)", () => {
  it("leaves no foreign key in public without an index", () => {
    expect(runSql(UNINDEXED_FKS)).toBe("");
  });

  it("leaves no invalid index behind", () => {
    expect(runSql("select indexrelid::regclass from pg_index where not indisvalid")).toBe("");
  });

  it("keeps pg_trgm and unaccent in the extensions schema, and search still unaccents", () => {
    expect(runSql(`select string_agg(extname || ':' || extnamespace::regnamespace, ',' order by extname)
      from pg_extension where extname in ('pg_trgm', 'unaccent')`)).toBe("pg_trgm:extensions,unaccent:extensions");
    expect(runSql("select public.food_name_norm('Crème Brûlée, vanilla')")).toBe("creme brulee");
    expect(runSql("select public.catalog_search_doc('Jalapeño', null, null)::text")).toContain("'jalapeno':1A");
    // As the app's role, the trigram and unaccent calls inside catalog_search still resolve.
    expect(runSql("begin; set local role authenticated; select 'ok' from (select count(*) from public.catalog_search('creme', null, null, 5)) s; rollback;")
      .split("\n")).toContain("ok");
  });

  it("refuses a turn on a deleted thread and writes nothing", () => {
    const user = crypto.randomUUID();
    const thread = crypto.randomUUID();
    const row = JSON.stringify([{ id: crypto.randomUUID(), thread_id: thread, user_id: user,
      role: "user", content: "hi", seq: 1, tool_calls: [] }]);
    const out = runSql(`
      begin;
      insert into auth.users (id) values ('${user}');
      insert into public.coach_threads (id, user_id, kind, deleted_at) values ('${thread}', '${user}', 'chat', now());
      do $$ begin
        perform public.coach_save_turn('${user}', '${thread}', 'chat', null, '${row}'::jsonb, null);
        raise notice 'saved';
      exception when others then
        perform set_config('w126.err', sqlerrm, true);
      end $$;
      select current_setting('w126.err', true) || '|' ||
        (select count(*) from public.coach_messages where thread_id = '${thread}');
      rollback;`);
    expect(out.split("\n").filter((line) => line.includes("|"))).toEqual(["coach_thread_deleted|0"]);
  });
});
