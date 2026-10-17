import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveLabels, type LabelledQuery } from "@/lib/search/eval";
import { combine, featuresFromRow } from "@/lib/search/features";
import { expandQuery, parseQuery } from "@/lib/search/query";
import { anonClient, ensureUser, userClient } from "../helpers/supabase";
import { sql } from "./fixtures";
import { type Hit, HAS_SQL, MISS_QUERIES, RUN_CATALOG, synonymMap } from "./recall-shared";

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
