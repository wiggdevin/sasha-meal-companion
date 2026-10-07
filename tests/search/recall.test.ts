import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveLabels, type LabelledQuery } from "@/lib/search/eval";
import { expandQuery, parseQuery } from "@/lib/search/query";
import { ensureUser, HAS_BRANCH, runSql, userClient } from "../helpers/supabase";
import { exec, HAS_DB, sql } from "./fixtures";

const SYNONYMS = new Map<string, string>([
  ["albacore", "tuna white"],
  ["canned albacore", "tuna white canned"],
  ["egg", "egg whole"],
  ["egg whites", "egg white raw"],
  ["chkn", "chicken"],
  ["brst", "breast"],
]);

describe("expandQuery", () => {
  it("returns the normalised query when nothing matches", () => {
    expect(expandQuery("grilled halibut", SYNONYMS)).toBe("grilled halibut");
  });

  it("lowercases and strips accents before matching", () => {
    expect(expandQuery("  ALBACORE  ", SYNONYMS)).toBe("tuna white");
    expect(expandQuery("Crème", SYNONYMS)).toBe("creme");
  });

  it("replaces each matching token", () => {
    expect(expandQuery("chkn brst", SYNONYMS)).toBe("chicken breast");
  });

  it("prefers a two-word term over its first token", () => {
    expect(expandQuery("egg whites", SYNONYMS)).toBe("egg white raw");
    expect(expandQuery("egg", SYNONYMS)).toBe("egg whole");
  });

  it("consumes both tokens of a matched pair", () => {
    expect(expandQuery("canned albacore chkn", SYNONYMS)).toBe("tuna white canned chicken");
  });

  it("does not expand an expansion a second time", () => {
    expect(expandQuery("albacore", new Map([["albacore", "egg"], ["egg", "egg whole"]]))).toBe("egg");
  });

  it("collapses runs of whitespace and returns empty for an empty query", () => {
    expect(expandQuery("chkn\t\n brst", SYNONYMS)).toBe("chicken breast");
    expect(expandQuery("   ", SYNONYMS)).toBe("");
  });
});

const CSV_PATH = "docs/catalog/synonyms.csv";
const CSV_HEADER = "term,expansion,source";
const SOURCES = ["miss", "typo", "unresolved", "guard", "kitchen"];

/** The 14 ranking misses in docs/catalog/relevance.md (2026-09-11). */
export const MISS_QUERIES = [
  "canned albacore", "eggs", "white rice", "sweet potato", "salmon", "scallops", "carrot",
  "pumpkin puree", "rotisserie chicken", "chicken thigh roasted", "white rice cooked",
  "chkn brst", "sweet potatoe", "salmom",
];

/**
 * "chicken thigh roasted" is exempt from the synonym-changes-every-miss check (controller
 * ruling A, 2026-09-11): `parseQuery` lifts "roasted" as a prep word before the RPC ever
 * sees the string, so this miss reaches SQL as "chicken thigh" — the same string as the
 * passing label "chicken thigh". A synonym keyed on "chicken thigh" cannot change one
 * without changing the other, so no CSV row can fix this miss without breaking a pass.
 */
const VOCAB_EXEMPT = ["chicken thigh roasted"];

/** The 5 with no row in any imported source. "mct oil" is deliberately left unmapped. */
const UNRESOLVED_QUERIES = ["jasmine rice", "avocado mayo", "fruit pouch", "mct oil", "duck fat"];

export function readSynonymsCsv(): { term: string; expansion: string; source: string }[] {
  const lines = readFileSync(CSV_PATH, "utf8").trim().split("\n");
  expect(lines[0]).toBe(CSV_HEADER);
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    expect(cells).toHaveLength(3);
    return { term: cells[0], expansion: cells[1], source: cells[2] };
  });
}

export function synonymMap(): Map<string, string> {
  return new Map(readSynonymsCsv().map((r) => [r.term, r.expansion]));
}

describe("docs/catalog/synonyms.csv", () => {
  const rows = readSynonymsCsv();

  it("carries at least 40 rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it("keeps every term lowercase, unaccented and one or two tokens", () => {
    for (const r of rows) {
      expect(r.term).toBe(r.term.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
      expect(r.term.trim()).toBe(r.term);
      expect(r.term.split(" ").length).toBeLessThanOrEqual(2);
      expect(r.term.length).toBeGreaterThan(0);
      expect(r.expansion.trim()).toBe(r.expansion);
      expect(r.expansion.length).toBeGreaterThan(0);
      expect(SOURCES).toContain(r.source);
    }
  });

  it("names each term once", () => {
    expect(new Set(rows.map((r) => r.term)).size).toBe(rows.length);
  });

  it("never expands a term into itself", () => {
    for (const r of rows) expect(r.expansion).not.toBe(r.term);
  });

  it("changes every miss query in relevance.md", () => {
    const map = synonymMap();
    for (const q of MISS_QUERIES.filter((q) => !VOCAB_EXEMPT.includes(q))) {
      expect(expandQuery(q, map), `"${q}" is unchanged`).not.toBe(expandQuery(q, new Map()));
    }
  });

  it("changes every unresolved query except mct oil, which stays unmapped on purpose", () => {
    const map = synonymMap();
    for (const q of UNRESOLVED_QUERIES.filter((x) => x !== "mct oil")) {
      expect(expandQuery(q, map), `"${q}" is unchanged`).not.toBe(expandQuery(q, new Map()));
    }
    expect(expandQuery("mct oil", map)).toBe("mct oil");
  });
});

const HAS_SQL = HAS_BRANCH && HAS_DB;

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

import { execFileSync } from "node:child_process";

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

const RUN_CATALOG = HAS_BRANCH && HAS_DB && process.env.CATALOG_ACTIVE === "1";

type Hit = { catalog_food_id: number; description: string; source: string; score: number;
  f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
  f_prior: number; f_quality: number; f_eats: number };

describe.skipIf(!RUN_CATALOG)("recall after Lane O", () => {
  let client: SupabaseClient;
  let labels: LabelledQuery[];
  const hits = new Map<string, Hit[]>();

  beforeAll(async () => {
    execFileSync("pnpm", ["exec", "tsx", "scripts/load-synonyms.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: process.env.SUPABASE_TEST_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
      },
    });
    client = await userClient(await ensureUser("a"));
    const raw = readFileSync("docs/catalog/labelled-queries.jsonl", "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as LabelledQuery);
    const ids = [...new Set(raw.map((l) => l.sourceId).filter((s) => s.length > 0))];
    const { data } = await client.from("catalog_foods").select("id, source, source_id").in("source_id", ids);
    labels = resolveLabels(
      raw,
      new Map(((data ?? []) as { id: number; source: string; source_id: string }[])
        .map((r) => [`${r.source}:${r.source_id}`, r.id] as const))
    );
    for (const l of labels) {
      const p = parseQuery(l.q);
      const { data: rows, error } = await client.rpc("catalog_search", {
        p_q: p.raw, p_brand: p.brand, p_prep: p.prep, p_limit: 25,
      });
      expect(error).toBeNull();
      hits.set(l.q, (rows ?? []) as Hit[]);
    }
  }, 180_000);

  const rankOf = (l: LabelledQuery) =>
    (hits.get(l.q) ?? []).findIndex((h) => String(h.catalog_food_id) === l.sourceId);

  it("reaches all 14 relevance.md misses inside the top 25", () => {
    const still: string[] = [];
    for (const q of MISS_QUERIES) {
      const l = labels.find((x) => x.q === q);
      expect(l, `"${q}" is not in labelled-queries.jsonl`).toBeDefined();
      expect(l!.sourceId.length, `"${q}" did not resolve to a catalog_foods id`).toBeGreaterThan(0);
      if (rankOf(l!) < 0) still.push(q);
    }
    expect(still, `still out of the candidate set: ${still.join(", ")}`).toEqual([]);
  });

  it("reports where each former miss now ranks", () => {
    for (const q of MISS_QUERIES) {
      const l = labels.find((x) => x.q === q)!;
      console.log(`  ${q}: rank ${rankOf(l) + 1} of ${(hits.get(q) ?? []).length}`);
    }
    expect(MISS_QUERIES).toHaveLength(14);
  });

  it("keeps every query that was already top-3 in the top 3", () => {
    const resolved = labels.filter((l) => l.sourceId.length > 0 && !MISS_QUERIES.includes(l.q));
    expect(resolved.length).toBe(47);
    const lost: string[] = [];
    for (const l of resolved) {
      const at = rankOf(l);
      if (at < 0 || at >= 3) lost.push(`${l.q} (rank ${at + 1})`);
    }
    expect(lost, `expansion pushed these out of the top 3: ${lost.join(", ")}`).toEqual([]);
  });
});

import { anonClient } from "../helpers/supabase";

describe.skipIf(!HAS_SQL)("catalog_synonyms through PostgREST", () => {
  let client: SupabaseClient;

  beforeAll(async () => {
    client = await userClient(await ensureUser("a"));
  });

  it("lets a signed-in user read it", async () => {
    const { data, error } = await client.from("catalog_synonyms").select("term, expansion").limit(5);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("refuses every write from a signed-in user", async () => {
    const insert = await client.from("catalog_synonyms").insert({ term: "hax", expansion: "hax" });
    expect(insert.error).not.toBeNull();
    const update = await client.from("catalog_synonyms").update({ expansion: "hax" }).eq("term", "albacore");
    expect(update.error).not.toBeNull();
    const remove = await client.from("catalog_synonyms").delete().eq("term", "albacore");
    expect(remove.error).not.toBeNull();
    expect(sql(`select expansion from public.catalog_synonyms where term = 'albacore'`)).toBe("tuna white");
  });

  it("shows nothing to an anonymous caller", async () => {
    const { data, error } = await anonClient().from("catalog_synonyms").select("term").limit(1);
    expect(error).not.toBeNull();
    expect(data ?? []).toEqual([]);
  });
});

import { combine, featuresFromRow } from "@/lib/search/features";

describe.skipIf(!RUN_CATALOG)("SQL and TypeScript expansion agree", () => {
  let client: SupabaseClient;
  let map: Map<string, string>;
  let queries: string[];

  beforeAll(async () => {
    client = await userClient(await ensureUser("a"));
    map = synonymMap();
    queries = readFileSync("docs/catalog/labelled-queries.jsonl", "utf8")
      .trim().split("\n").map((l) => (JSON.parse(l) as LabelledQuery).q);
  });

  it("expands every labelled query the same way in both languages", () => {
    for (const q of queries) {
      expect(sql(`select public.catalog_expand_query('${q.replace(/'/g, "''")}')`)).toBe(expandQuery(q, map));
    }
  }, 30_000);

  it("still reproduces the SQL score from the seven feature columns", async () => {
    for (const q of ["canned albacore", "eggs", "white rice", "rotisserie chicken", "chkn brst"]) {
      const p = parseQuery(q);
      const { data, error } = await client.rpc("catalog_search", {
        p_q: p.raw, p_brand: p.brand, p_prep: p.prep, p_limit: 25,
      });
      expect(error).toBeNull();
      const rows = (data ?? []) as Hit[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(combine(featuresFromRow(r))).toBeCloseTo(Number(r.score), 4);
      }
    }
  });
});
