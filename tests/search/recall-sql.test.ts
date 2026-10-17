import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { runSql } from "../helpers/supabase";
import { exec, sql } from "./fixtures";
import { HAS_SQL, readSynonymsCsv } from "./recall-shared";

describe.skipIf(!HAS_SQL)("catalog_synonyms table", () => {
  it("has the contracts §7 columns", () => {
    expect(
      sql(`select string_agg(column_name || ':' || data_type, ',' order by ordinal_position)
             from information_schema.columns
            where table_schema = 'public' and table_name = 'catalog_synonyms'`)
    ).toBe("term:text,expansion:text,source:text");
  });

  it("keys on term and defaults source to curated", () => {
    expect(
      sql(`select count(*) from pg_index i join pg_class c on c.oid = i.indrelid
            where c.relname = 'catalog_synonyms' and i.indisprimary`)
    ).toBe("1");
    expect(
      sql(`select column_default from information_schema.columns
            where table_name = 'catalog_synonyms' and column_name = 'source'`)
    ).toBe("'curated'::text");
  });

  it("is select-only for authenticated and closed to anon", () => {
    expect(sql(`select has_table_privilege('authenticated','public.catalog_synonyms','select')`)).toBe("t");
    for (const priv of ["insert", "update", "delete"]) {
      expect(sql(`select has_table_privilege('authenticated','public.catalog_synonyms','${priv}')`)).toBe("f");
    }
    expect(sql(`select has_table_privilege('anon','public.catalog_synonyms','select')`)).toBe("f");
    expect(sql(`select has_table_privilege('service_role','public.catalog_synonyms','insert')`)).toBe("t");
  });
});

describe.skipIf(!HAS_SQL)("catalog_expand_query", () => {
  beforeAll(() => {
    exec(`
      create table if not exists public.catalog_synonyms (
        term text primary key, expansion text not null, source text not null default 'curated');
      delete from public.catalog_synonyms where source = 'unit';
      insert into public.catalog_synonyms (term, expansion, source) values
        ('albacore', 'tuna white', 'unit'),
        ('canned albacore', 'tuna white canned', 'unit'),
        ('egg', 'egg whole', 'unit'),
        ('egg whites', 'egg white raw', 'unit'),
        ('chkn', 'chicken', 'unit'),
        ('brst', 'breast', 'unit')
      on conflict (term) do update set expansion = excluded.expansion, source = 'unit';
    `);
  });

  const expand = (q: string) =>
    sql(`select public.catalog_expand_query(${q === null ? "null" : `'${q.replace(/'/g, "''")}'`})`);

  it("leaves an unmatched query alone, normalised", () => {
    expect(expand("  GRILLED   Halibut ")).toBe("grilled halibut");
  });

  it("unaccents before matching", () => {
    expect(expand("Crème")).toBe("creme");
  });

  it("replaces each matching token", () => {
    expect(expand("chkn brst")).toBe("chicken breast");
  });

  it("prefers the two-word term and consumes both tokens", () => {
    expect(expand("egg whites")).toBe("egg white raw");
    expect(expand("canned albacore chkn")).toBe("tuna white canned chicken");
  });

  it("returns the empty string for an empty or null query", () => {
    expect(expand("   ")).toBe("");
    expect(sql(`select coalesce(public.catalog_expand_query(null), '<null>')`)).toBe("");
  });

  it("is stable, security invoker, execute-granted to authenticated only", () => {
    const SIG = "public.catalog_expand_query(text)";
    expect(
      sql(`select provolatile::text || prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'catalog_expand_query'`)
    ).toBe("sfalse");
    expect(sql(`select has_function_privilege('authenticated', '${SIG}', 'execute')`)).toBe("t");
    expect(sql(`select has_function_privilege('anon', '${SIG}', 'execute')`)).toBe("f");
  });
});

describe.skipIf(!HAS_SQL)("catalog_search shape after Lane O", () => {
  const SIG = "public.catalog_search(text,text,text,integer)";

  it("keeps the contracts §2 identity arguments and one definition", () => {
    expect(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'catalog_search'`)
    ).toBe("1");
    expect(sql(`select pg_get_function_identity_arguments('${SIG}'::regprocedure)`)).toBe(
      "p_q text, p_brand text, p_prep text, p_limit integer"
    );
  });

  // T1 (20261018090200) added two columns after `pref_status`: `category`, the provider's own text,
  // and `policy_categories`, the controlled keys the policy compares. A hit that has never been
  // annotated derives its keys from the pair, so both travel together and both are pinned here.
  it("keeps the 19 return columns in order", () => {
    expect(sql(`select pg_get_function_result('${SIG}'::regprocedure)`).replace(/\s+/g, " ")).toBe(
      "TABLE(catalog_food_id bigint, revision_id bigint, description text, brand text, source text, " +
      "quality_class text, quality_flags text[], prep_state text, score numeric, pref_status text, " +
      "category text, policy_categories text[], " +
      "f_lexical numeric, f_trigram numeric, f_brand numeric, f_prep numeric, f_prior numeric, " +
      "f_quality numeric, f_eats numeric)"
    );
  });

  it("stays security invoker with the pinned search_path and both trigram thresholds", () => {
    const cfg = sql(`select array_to_string(proconfig, ' ') from pg_proc p
                       join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = 'catalog_search'`);
    expect(cfg).toContain("search_path=public, extensions, pg_temp");
    expect(cfg).toContain("pg_trgm.similarity_threshold=0.25");
    expect(cfg).toContain("pg_trgm.word_similarity_threshold=0.45");
    expect(
      sql(`select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'catalog_search'`)
    ).toBe("f");
  });

  it("carries the architecture §4.1 score expression unchanged", () => {
    const body = sql(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname = 'catalog_search'`);
    expect(body.replace(/\s+/g, " ")).toContain(
      "round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep " +
      "+ 0.10 * f_prior + 0.05 * f_quality + 0.05 * f_eats, 6) as score"
    );
  });

  it("builds tsq from the expanded query and keeps raw unexpanded", () => {
    const body = sql(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname = 'catalog_search'`);
    expect(body).toContain("websearch_to_tsquery('english', unaccent(public.catalog_expand_query(p_q)))");
    expect(body).toContain("unaccent(lower(coalesce(p_q, '')))                           as raw");
    expect(body.replace(/\s+/g, " ")).toContain(
      "(r.search_doc @@ q.tsq or r.description % q.raw or q.raw <% r.description)"
    );
  });
});

const DOWN_PATH = "supabase/migrations/down/20260921090000_catalog_synonyms.down.sql";
/**
 * Down files are applied in reverse order, and T1's (20261018090200) has to go first: it DROPS and
 * re-creates catalog_search to take two columns back off the return table, and Lane O's down uses
 * CREATE OR REPLACE, which cannot change a return type. Applying Lane O's alone on top of the
 * current schema fails with "cannot change return type of existing function". Both run inside the
 * one begin/rollback below, so neither reaches the branch's real schema.
 */
const T1_DOWN_PATH =
  "supabase/migrations/down/20261018090200_catalog_search_policy_categories.down.sql";
describe.skipIf(!HAS_SQL)("down migration", () => {
  it("restores the pre-Lane-O catalog_search and removes the table and helper", () => {
    // One connection and ROLLBACK preserve every later migration's policy and function change.
    const out = runSql(`begin;
      ${readFileSync(T1_DOWN_PATH, "utf8")}
      ${readFileSync(DOWN_PATH, "utf8")}
      select json_build_object(
        'body', (select prosrc from pg_proc where oid = 'public.catalog_search(text,text,text,integer)'::regprocedure),
        'config', (select array_to_string(proconfig, ' ') from pg_proc
          where oid = 'public.catalog_search(text,text,text,integer)'::regprocedure),
        'helpers', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'catalog_expand_query'),
        'removed', to_regclass('public.catalog_synonyms') is null
      );
      rollback;`);
    const state = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!);
    expect(state.body).toContain("websearch_to_tsquery('english', unaccent(coalesce(p_q, '')))" );
    expect(state.body).not.toContain("catalog_expand_query");
    expect(state.body.replace(/\s+/g, " ")).toContain("(r.search_doc @@ q.tsq or r.description % q.raw)");
    expect(state.config).not.toContain("word_similarity_threshold");
    expect(state.helpers).toBe(0);
    expect(state.removed).toBe(true);
    expect(sql(`select to_regclass('public.catalog_synonyms') is null`)).toBe("f");
  });
});

describe.skipIf(!HAS_SQL)("load-synonyms", () => {
  it("makes catalog_synonyms equal docs/catalog/synonyms.csv", () => {
    exec(`insert into public.catalog_synonyms (term, expansion, source)
            values ('zzz-stale', 'nothing', 'unit')
          on conflict (term) do update set expansion = 'nothing'`);
    execFileSync("pnpm", ["exec", "tsx", "scripts/load-synonyms.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: process.env.SUPABASE_TEST_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
      },
    });
    const rows = readSynonymsCsv();
    expect(sql(`select count(*) from public.catalog_synonyms`)).toBe(String(rows.length));
    expect(sql(`select expansion from public.catalog_synonyms where term = 'albacore'`)).toBe("tuna white");
    expect(sql(`select count(*) from public.catalog_synonyms where term = 'zzz-stale'`)).toBe("0");
  });
});
