import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  gateDecision,
  relevanceMetrics,
  resolveLabels,
  TOP1_GATE,
  TOP3_GATE,
  type LabelledQuery,
  type Runs,
} from "@/lib/search/eval";
import { parseQuery } from "@/lib/search/query";
import type { FoodSearchHit } from "@/lib/server/catalog";
import { ensureUser, HAS_BRANCH, userClient } from "../helpers/supabase";

const RUN = HAS_BRANCH && process.env.CATALOG_ACTIVE === "1";

describe.skipIf(!RUN)("labelled relevance", () => {
  let client: SupabaseClient;
  let labels: LabelledQuery[];
  let runs: Runs;

  beforeAll(async () => {
    client = await userClient(await ensureUser("a"));
    const raw = readFileSync("docs/catalog/labelled-queries.jsonl", "utf8")
      .trim().split("\n").map((l) => JSON.parse(l) as LabelledQuery);
    const ids = [...new Set(raw.map((l) => l.sourceId).filter((s) => s.length > 0))];
    const { data } = await client.from("catalog_foods").select("id, source, source_id").in("source_id", ids);
    const map = new Map(
      ((data ?? []) as { id: number; source: string; source_id: string }[])
        .map((r) => [`${r.source}:${r.source_id}`, r.id] as const)
    );
    labels = resolveLabels(raw, map);
    runs = [];
    for (const l of labels) {
      const p = parseQuery(l.q);
      const { data: hits } = await client.rpc("catalog_search", {
        p_q: p.raw, p_brand: p.brand, p_prep: p.prep, p_limit: 25,
      });
      runs.push(
        ((hits ?? []) as Record<string, unknown>[]).map(
          (r) => ({
            catalogFoodId: r.catalog_food_id, revisionId: r.revision_id, description: r.description,
            brand: r.brand, source: r.source, qualityClass: r.quality_class,
            qualityFlags: r.quality_flags ?? [], prepState: r.prep_state, score: Number(r.score),
            prefStatus: r.pref_status,
          }) as unknown as FoodSearchHit
        )
      );
    }
  }, 120_000);

  it("carries at least 60 resolved labelled queries", () => {
    expect(relevanceMetrics(labels, runs).n).toBeGreaterThanOrEqual(60);
  });

  it(`reaches top-1 ≥ ${TOP1_GATE * 100} % and top-3 ≥ ${TOP3_GATE * 100} % (ruling R1, 2026-09-12)`, () => {
    const m = relevanceMetrics(labels, runs);
    const decision = gateDecision({ top1: m.top1, top3: m.top3 });
    if (!decision.pass) console.log("misses:", m.misses.map((x) => x.q).join(", "));
    expect(decision.reasons).toEqual([]);
  });
});
