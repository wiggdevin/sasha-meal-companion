import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandMatchScore, combine, eatsStatusScore, featuresFromRow, prepStateMatchScore,
  qualityClassScore, userPriorScore, type QualityClass,
} from "@/lib/search/features";
import type { PrepState } from "@/lib/search/query";
import { ensureUser, HAS_BRANCH, resetUser, userClient } from "../helpers/supabase";
import {
  dropCatalogFixture, fixtureRevisionIds, fixtureToken, HAS_DB, seedCatalogFixture,
} from "./fixtures";

const RUN = HAS_BRANCH && HAS_DB;
const TAG = "parity";
// Every query carries the fixture token so the ten seeded rows outrank the real catalog on a
// loaded branch (see fixtureToken). Score parity is asserted on every returned row, real or
// seeded; the feature-semantics assertions below are kept to the seeded rows, whose brand,
// prep state and quality flags are known.
const TOKEN = fixtureToken(TAG);

type Row = {
  revision_id: number; description: string; score: number;
  brand: string | null; prep_state: string | null; quality_class: string; quality_flags: string[];
  pref_status: "eats" | "avoid" | null;
  f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
  f_prior: number; f_quality: number; f_eats: number;
};

describe.skipIf(!RUN)("catalog_search score parity", () => {
  let client: SupabaseClient;
  let seeded: Set<number>;

  beforeAll(async () => {
    seedCatalogFixture(TAG);
    seeded = fixtureRevisionIds(TAG);
    const a = await ensureUser("a");
    await resetUser(a.id);
    client = await userClient(a);
  });

  afterAll(() => {
    dropCatalogFixture(TAG);
  });

  async function search(q: string, brand: string | null = null, prep: string | null = null) {
    const { data, error } = await client.rpc("catalog_search", {
      p_q: `${TOKEN} ${q}`, p_brand: brand, p_prep: prep, p_limit: 25,
    });
    expect(error).toBeNull();
    return (data ?? []) as Row[];
  }

  /** The seeded rows only, for assertions that depend on known brand, prep or flags. */
  async function searchSeeded(q: string, brand: string | null = null, prep: string | null = null) {
    return (await search(q, brand, prep)).filter((r) => seeded.has(r.revision_id));
  }

  it("returns the ten fixture rows across the queries that reach them", async () => {
    expect(seeded.size).toBe(10);
    const seen = new Set<number>();
    for (const q of ["chicken", "rice", "sweet potato", "olive oil", "avocado"]) {
      for (const r of await searchSeeded(q)) seen.add(r.revision_id);
    }
    expect(seen.size).toBe(10);
  });

  it("scores every returned row exactly as combine() does", async () => {
    const rows = [
      ...(await search("chicken")),
      ...(await search("rice", null, "cooked")),
      ...(await search("olive oil", "Kirkland")),
      ...(await search("avocado")),
      ...(await search("sweet potato")),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      expect(combine(featuresFromRow(r))).toBeCloseTo(Number(r.score), 4);
    }
  });

  it("scores each feature exactly as the TypeScript feature functions do", async () => {
    const kirklandRows = await searchSeeded("olive oil", "Kirkland");
    const riceRows = await searchSeeded("rice", null, "cooked");
    const avocadoRows = await searchSeeded("avocado");

    const runs: { rows: Row[]; queryPrep: PrepState | null }[] = [
      { rows: kirklandRows, queryPrep: null },
      { rows: riceRows, queryPrep: "cooked" },
      { rows: avocadoRows, queryPrep: null },
    ];

    for (const { rows, queryPrep } of runs) {
      for (const r of rows) {
        expect(Number(r.f_prep)).toBe(prepStateMatchScore(queryPrep, r.prep_state as PrepState | null));
        expect(Number(r.f_quality)).toBeCloseTo(
          qualityClassScore(r.quality_class as QualityClass, r.quality_flags), 6
        );
        expect(Number(r.f_eats)).toBe(eatsStatusScore(r.pref_status));
        expect(Number(r.f_prior)).toBeCloseTo(userPriorScore(0), 6);
      }
    }

    const extraVirgin = kirklandRows.find((r) => r.description.includes("extra virgin"));
    expect(brandMatchScore("Kirkland", extraVirgin?.brand ?? null, 0)).toBe(1);
    expect(Number(extraVirgin?.f_brand)).toBe(1);

    for (const r of kirklandRows) {
      if (r === extraVirgin) continue;
      expect([0, 0.6]).toContain(Number(r.f_brand));
      expect(brandMatchScore("Kirkland", r.brand, 0)).toBe(0);
    }
  });

  it("keeps every feature and the score inside [0,1]", async () => {
    for (const r of await search("chicken")) {
      for (const v of [r.f_lexical, r.f_trigram, r.f_brand, r.f_prep, r.f_prior, r.f_quality, r.f_eats, r.score]) {
        expect(Number(v)).toBeGreaterThanOrEqual(0);
        expect(Number(v)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("scores an exact brand match at 1 and a query with no brand at 0", async () => {
    const branded = (await searchSeeded("olive oil", "Kirkland")).find((r) => r.description.includes("extra virgin"));
    expect(Number(branded?.f_brand)).toBe(1);
    const plain = await searchSeeded("olive oil");
    expect(plain.every((r) => Number(r.f_brand) === 0)).toBe(true);
  });

  it("scores prep match, unknown and conflict at 1, 0.5 and 0", async () => {
    const rows = await searchSeeded("rice", null, "cooked");
    const cooked = rows.find((r) => r.description.includes("cooked"));
    const raw = rows.find((r) => r.description.endsWith("raw"));
    expect(Number(cooked?.f_prep)).toBe(1);
    expect(Number(raw?.f_prep)).toBe(0);
    const noPrepQuery = await searchSeeded("olive oil");
    expect(noPrepQuery.every((r) => Number(r.f_prep) === 0.5)).toBe(true);
  });

  it("drops an energy_mismatch row by the architecture §4.1 penalty", async () => {
    const rows = await searchSeeded("avocado");
    const flagged = rows.find((r) => r.description.startsWith("Avocado, raw"));
    const crowd = rows.find((r) => r.description.startsWith("Avocado spread"));
    expect(Number(flagged?.f_quality)).toBeCloseTo(0.75, 6);  // analytical 1.0 − 0.25
    expect(Number(crowd?.f_quality)).toBeCloseTo(0, 6);       // crowd 0.25 − 0.25, floored at 0
  });

  it("never returns more than the limit, and never more than 25", async () => {
    const { data } = await client.rpc("catalog_search", {
      p_q: "chicken", p_brand: null, p_prep: null, p_limit: 2,
    });
    expect((data ?? []).length).toBeLessThanOrEqual(2);
    const { data: big } = await client.rpc("catalog_search", {
      p_q: "chicken", p_brand: null, p_prep: null, p_limit: 500,
    });
    expect((big ?? []).length).toBeLessThanOrEqual(25);
  });
});
