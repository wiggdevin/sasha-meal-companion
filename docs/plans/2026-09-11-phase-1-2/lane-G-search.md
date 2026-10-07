# Lane G — Search (Phase 1)

**For agentic workers:** execute this plan with `superpowers:subagent-driven-development`. One task per
subagent, in order. Each task is self-contained: it names the files, the exact interfaces it consumes and
produces, the failing test, the command that proves it fails, the complete implementation, the command
that proves it passes, and the commit.

## Goal

Serve the architecture §4.1 ranked catalog search. Ship the `catalog_search` RPC (`security invoker`, so the
caller's own prefs and log counts — and only the caller's — feed the score), the pure TypeScript mirror of
that score, the two read routes behind it, the labelled query set, the relevance/calibration tooling, and
the script that applies Devin's reviewed food mapping.

## Architecture

`GET /api/foods/search` and `GET /api/foods/[id]` are thin: rate limit → identity → zod query parse →
`lib/server/catalog.ts` → `jsonError`. `lib/server/catalog.ts` is the only module the routes talk to; it
calls the `catalog_search` RPC and the detail read on the **request-local, RLS-scoped** client that
`requireUser` returns — never `adminClient()`. Scoring lives in Postgres, inside the RPC, because the two
personalised features (90-day prior count, eats/avoid status) are joins the browser cannot make. The RPC
returns the seven feature columns alongside the score so `lib/search/features.ts` can reproduce the number
byte-for-byte on the same inputs; a branch test proves the two do not drift.

`lib/search/*` is pure and has no I/O: query parsing, the feature/weight table, the calibrated auto-resolve
thresholds, GTIN normalisation, and the relevance/calibration maths. `scripts/search-eval.ts` runs the
labelled set against a real branch and rewrites `lib/search/thresholds.ts` with the calibrated values.
`scripts/apply-food-mapping.ts` is the only writer in this lane, and it writes through `adminClient()`.

## Tech Stack

Next.js 16.3.4 (App Router, `runtime = "nodejs"`), React 19.2.8, TypeScript 5 strict, Tailwind 4, pnpm 11.25.0,
Node 22, vitest 5 (`environment: "node"`, `include: ["**/*.test.ts"]`, `@` → repo root), zod 4.5.x,
`@supabase/supabase-js` 2.116.x, `@supabase/ssr` 0.12.x, Supabase Postgres 17 (`pg_trgm`, `unaccent` in the
`extensions` schema), Vercel. Scripts run as `pnpm exec tsx scripts/<name>.ts`. **No new npm dependency**
(Phase 1–2 contracts §7).

## Spec paths

- `docs/plans/2026-09-11-phase-1-2/00-contracts.md` §1 (ownership), §2 (score + RPC signature), §3 (wire types), §8 (conventions)
- `docs/plans/2026-09-10-phase-0/00-contracts.md` §2 (`get_or_create_food_ref`), §4 (entity keys), §5 (auth helpers), §8
- `docs/specs/phase-1-catalog.md` — API changes, Engines and logic, Security, Test plan, Acceptance criteria
- `docs/architecture.md` §3.1 (catalog DDL), §3.2 (`food_refs`, `user_food_prefs`), §3.3 (`log_entries`, `log_items`), §4.1 (the score and its SQL), §5 (endpoint matrix), §7 (import and capacity)
- `AGENTS.md` (commands, branch rules, CI gate), `DESIGN.md` (not exercised — this lane ships no UI; every
  component in the Phase 1 spec's "Client changes" belongs to Lane I)

## Global Constraints

From Phase 0 contracts §8:

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, **no AI attribution lines**.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` is never read from a request body or a query string. Errors are `{ error, message }` and never echo the input.
- Every route: `enforceRateLimit` first, then identity, then input parse.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full suite twice.

From Phase 1–2 contracts §8:

- Every SQL function that reads user rows is either `security invoker` (browser path) or `security definer`
  with `p_user_id` first and execute revoked from `authenticated` (privileged path) — never both, never neither.
  `catalog_search` is the invoker case.

Lane-specific:

- Branch `feat/p1-search`. Create or modify **only** the files in the File structure table.
  `lib/server/auth.ts`, `lib/server/http.ts`, `lib/server/admin.ts`, `lib/server/ratelimit.ts`,
  `lib/sync/**`, `package.json`, `vitest.config.ts`, `docs/architecture.md`, `DESIGN.md` and every
  `catalog_tables` / `catalog_grants` / `catalog_activate` migration belong to other lanes.
- **Phase 0 lane files may not exist on this checkout.** `lib/server/auth.ts`, `lib/server/http.ts`,
  `lib/server/admin.ts`, `lib/server/ratelimit.ts`, `lib/supabase/server.ts` and `tests/helpers/supabase.ts`
  are Lane B / Lane A deliverables. Code against the Phase 0 contract signatures reproduced in each task's
  **Interfaces → Consumes** block. If a file is still missing when a task runs, the task's own unit test is
  still written and run first; the import resolves once Phase 0 release A is on `main`, which is the start
  condition for this lane (Phase 1–2 contracts, Start condition).
- Lane F's tables may be empty. Every branch test in this lane inserts its own fixture rows with `psql`.
- `SUPABASE_SERVICE_ROLE_KEY` appears in no file this lane creates. `scripts/apply-food-mapping.ts` reaches
  the service role only through `adminClient()`.

## File structure

| File | Responsibility |
|---|---|
| Create `supabase/migrations/20260912090100_catalog_search.sql` | The `catalog_search` RPC: `security invoker`, contracts §2 score, feature columns, active-version filter, limit ≤ 25, grants. |
| Create `lib/search/query.ts` | `PREP_STATES`, `parseQuery` (trailing `brand:` or quoted brand, one prep word), `classifyQuery`, `normalizeBrand`. |
| Create `lib/search/query.test.ts` | Brand and prep extraction, promotion-removes-from-raw, accents, branded/generic classification. |
| Create `lib/search/features.ts` | `WEIGHTS`, `combine`, the five per-feature scores, `featuresFromRow` (RPC columns → `Features`). |
| Create `lib/search/features.test.ts` | Weights sum to 1.00, every feature in `[0,1]`, `combine` bounded, `userPriorScore(20) === 1`, mismatch penalty floors at 0. |
| Create `lib/search/thresholds.ts` | `AUTO_RESOLVE` (provisional 0.80 / 0.15, overwritten by the eval), `shouldAutoResolve`. |
| Create `lib/search/thresholds.test.ts` | Score and margin both required; a single hit never auto-resolves. |
| Create `lib/search/gtin.ts` | `toGtin14` — EAN-8 / UPC-A / EAN-13 / GTIN-14 padded and check-digit verified. |
| Create `lib/search/gtin.test.ts` | Real GTINs pad correctly; a bad check digit and an all-zero code return null. |
| Create `lib/search/eval.ts` | `resolveLabels`, `relevanceMetrics`, `calibrate` (smallest threshold pair at ≥ 98 % precision). |
| Create `lib/search/eval.test.ts` | Metrics on a fixture with known misses; calibration picks the smallest eligible pair. |
| Create `lib/server/catalog.ts` | Wire types, `searchFoods`, `getFoodDetail`, `attributionFor`, `clientIp`, `withRetryAfter`, `NoActiveCatalogVersion`. |
| Create `lib/server/catalog.test.ts` | `attributionFor`, `clientIp`, `withRetryAfter`, and `searchFoods` / `getFoodDetail` against a mocked client. |
| Create `app/api/foods/search/route.ts` | `GET` — two-tier rate limit, `requireUser`, zod query parse, `searchFoods`, `jsonError`, `Retry-After` on 429. |
| Create `app/api/foods/[id]/route.ts` | `GET` — same chain, `getFoodDetail`, 404 on an unknown or inactive `catalogFoodId`. |
| Create `tests/search/search-route.test.ts` | 200 / 401 / 400 / 429 / 503 for the search route, client mocked. |
| Create `tests/search/detail-route.test.ts` | 200 / 401 / 400 / 404 / 503 for the detail route, client mocked. |
| Create `docs/catalog/labelled-queries.jsonl` | 66 labelled queries from her 53 foods, `lib/food-db.json` names and common misspellings. |
| Create `scripts/search-eval.ts` | Runs the labelled set through the RPC on a branch, prints top-1 / top-3, rewrites `lib/search/thresholds.ts`. |
| Create `scripts/apply-food-mapping.ts` | Applies the reviewed mapping CSV: `user_foods.catalog_food_id` + `get_or_create_food_ref`; refuses a blank decision. |
| Create `tests/search/fixtures.ts` | `psql` helpers and the ten-row catalog fixture the branch tests share. |
| Create `tests/search/rpc-security.test.ts` | **[needs branch]** `pg_proc.prosecdef = false`; execute revoked from `anon`/`public`. |
| Create `tests/search/score-parity.test.ts` | **[needs branch]** SQL score equals `combine()` on the ten fixture rows. |
| Create `tests/search/cross-user.test.ts` | **[needs branch]** User B's search never reflects user A's prefs or log counts. |
| Create `tests/search/relevance.test.ts` | **[needs branch, `CATALOG_ACTIVE=1`]** top-1 ≥ 85 %, top-3 ≥ 95 % on the labelled set. |

---

## Task 1 — Query parsing and classification

**Files**
- Create: `lib/search/query.ts`
- Test: `lib/search/query.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces:
  ```ts
  export const PREP_STATES: readonly ['raw','cooked','roasted','grilled','fried','boiled','baked','unknown'];
  export type PrepState = (typeof PREP_STATES)[number];
  export const PREP_WORDS: readonly PrepState[];              // the seven a query can carry; never 'unknown'
  export type ParsedQuery = { raw: string; brand: string | null; prep: PrepState | null };
  export function parseQuery(input: string): ParsedQuery;
  export function classifyQuery(q: ParsedQuery): 'branded' | 'generic';
  export function normalizeBrand(s: string): string;
  ```
  `PrepState` is the contracts §3 union. A token promoted to a field leaves `raw`, so `raw` is what reaches
  `websearch_to_tsquery` and `brand` / `prep` reach the RPC as their own parameters. `raw` keeps the user's
  capitalisation — `classifyQuery` reads it, and the SQL lowercases.

### Steps

- [ ] Write the failing test — create `lib/search/query.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { classifyQuery, normalizeBrand, parseQuery, PREP_STATES } from "./query";

  describe("parseQuery", () => {
    it("takes a trailing brand: field and drops it from raw", () => {
      expect(parseQuery("olive oil brand:Kirkland")).toEqual({
        raw: "olive oil", brand: "Kirkland", prep: null,
      });
    });

    it("takes a quoted brand: value with spaces", () => {
      expect(parseQuery('rolled oats brand:"Bob\'s Red Mill"')).toEqual({
        raw: "rolled oats", brand: "Bob's Red Mill", prep: null,
      });
    });

    it("takes a quoted phrase anywhere as the brand", () => {
      expect(parseQuery('"Rao\'s" marinara sauce')).toEqual({
        raw: "marinara sauce", brand: "Rao's", prep: null,
      });
    });

    it("lifts one prep word out of the query", () => {
      expect(parseQuery("chicken thigh roasted")).toEqual({
        raw: "chicken thigh", brand: null, prep: "roasted",
      });
      expect(parseQuery("Boiled white potato")).toEqual({
        raw: "white potato", brand: null, prep: "boiled",
      });
    });

    it("lifts only the first prep word", () => {
      expect(parseQuery("raw or cooked spinach")).toMatchObject({ raw: "or cooked spinach", prep: "raw" });
    });

    it("never returns an empty raw", () => {
      expect(parseQuery("brand:Kirkland")).toEqual({ raw: "brand:Kirkland", brand: "Kirkland", prep: null });
      expect(parseQuery("roasted")).toEqual({ raw: "roasted", brand: null, prep: "roasted" });
    });

    it("collapses whitespace and trims", () => {
      expect(parseQuery("  sweet   potato  ")).toEqual({ raw: "sweet potato", brand: null, prep: null });
    });

    it("returns no brand and no prep for a plain query", () => {
      expect(parseQuery("ahi tuna")).toEqual({ raw: "ahi tuna", brand: null, prep: null });
    });

    it("never proposes 'unknown' as a parsed prep", () => {
      expect(PREP_STATES).toContain("unknown");
      expect(parseQuery("unknown food").prep).toBeNull();
    });
  });

  describe("normalizeBrand", () => {
    it("strips accents, lowercases, collapses whitespace", () => {
      expect(normalizeBrand("  Café   MÜLLER ")).toBe("cafe muller");
    });

    it("is stable for an already normal brand", () => {
      expect(normalizeBrand("kirkland")).toBe("kirkland");
    });
  });

  describe("classifyQuery", () => {
    it("is branded when a brand came out of the query", () => {
      expect(classifyQuery(parseQuery("olive oil brand:Kirkland"))).toBe("branded");
    });

    it("is branded on a capitalised run inside a lowercase query", () => {
      expect(classifyQuery(parseQuery("Kirkland Signature olive oil"))).toBe("branded");
    });

    it("is generic for a lowercase query", () => {
      expect(classifyQuery(parseQuery("chicken breast"))).toBe("generic");
    });

    it("is generic when the whole query is title-cased", () => {
      expect(classifyQuery(parseQuery("Chicken Breast"))).toBe("generic");
    });

    it("is generic for a single capitalised token", () => {
      expect(classifyQuery(parseQuery("RXBAR chocolate"))).toBe("generic");
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/search/query.test.ts
  ```
  Expected: `Failed to load url ./query` / `Cannot find module '.../lib/search/query'` — the file does not exist.

- [ ] Write `lib/search/query.ts`:
  ```ts
  /**
   * Query parsing for catalog search (Phase 1 spec, Engines and logic).
   *
   * A token promoted to a structured field leaves `raw`: the brand and the prep
   * state are scored as their own features (architecture §4.1), so leaving them
   * in the free text would also make `websearch_to_tsquery` AND on them and hide
   * rows that do not spell them out. `raw` keeps the caller's capitalisation —
   * `classifyQuery` reads it and the SQL lowercases.
   */

  export const PREP_STATES = [
    "raw", "cooked", "roasted", "grilled", "fried", "boiled", "baked", "unknown",
  ] as const;

  export type PrepState = (typeof PREP_STATES)[number];

  /** The seven a query can carry. 'unknown' is a wire value, never a parse result. */
  export const PREP_WORDS: readonly PrepState[] = [
    "raw", "cooked", "roasted", "grilled", "fried", "boiled", "baked",
  ];

  export type ParsedQuery = { raw: string; brand: string | null; prep: PrepState | null };

  const BRAND_FIELD = /\bbrand:\s*(?:"([^"]+)"|(\S+))\s*$/i;
  const QUOTED = /"([^"]+)"/;
  const CAPITALISED = /^[A-ZÀ-Þ][\w'&.À-ɏ-]*$/;

  export function normalizeBrand(s: string): string {
    return s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function liftBrand(text: string): { rest: string; brand: string | null } {
    const field = text.match(BRAND_FIELD);
    if (field) {
      const brand = (field[1] ?? field[2] ?? "").trim();
      return { rest: text.slice(0, field.index ?? 0).trim(), brand: brand.length > 0 ? brand : null };
    }
    const quoted = text.match(QUOTED);
    if (quoted) {
      const at = quoted.index ?? 0;
      const rest = `${text.slice(0, at)} ${text.slice(at + quoted[0].length)}`.replace(/\s+/g, " ").trim();
      const brand = quoted[1].trim();
      return { rest, brand: brand.length > 0 ? brand : null };
    }
    return { rest: text, brand: null };
  }

  function liftPrep(text: string): { rest: string; prep: PrepState | null } {
    const words = text.split(" ").filter(Boolean);
    const bare = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "");
    const at = words.findIndex((w) => (PREP_WORDS as readonly string[]).includes(bare(w)));
    if (at < 0) return { rest: text, prep: null };
    const prep = bare(words[at]) as PrepState;
    words.splice(at, 1);
    return { rest: words.join(" ").trim(), prep };
  }

  export function parseQuery(input: string): ParsedQuery {
    const original = (input ?? "").replace(/\s+/g, " ").trim();
    const { rest: afterBrand, brand } = liftBrand(original);
    const { rest, prep } = liftPrep(afterBrand);
    return { raw: rest.length > 0 ? rest : original, brand, prep };
  }

  /**
   * Branded when the query names a brand, or carries a run of two or more
   * capitalised tokens inside an otherwise lowercase query. A wholly title-cased
   * query is the phone keyboard, not a brand, so it stays generic.
   */
  export function classifyQuery(q: ParsedQuery): "branded" | "generic" {
    if (q.brand !== null) return "branded";
    const tokens = q.raw.split(" ").filter(Boolean);
    if (tokens.length < 2) return "generic";
    const caps = tokens.map((t) => CAPITALISED.test(t));
    if (caps.every(Boolean)) return "generic";
    let run = 0;
    let best = 0;
    for (const c of caps) {
      run = c ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best >= 2 ? "branded" : "generic";
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/search/query.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  16 passed`.

- [ ] Commit:
  ```bash
  git add lib/search/query.ts lib/search/query.test.ts
  git commit -m "feat: parse brand and prep out of a catalog search query"
  ```

---

## Task 2 — The feature table and the score mirror

**Files**
- Create: `lib/search/features.ts`
- Test: `lib/search/features.test.ts`

**Interfaces**
- Consumes: `PrepState`, `normalizeBrand` from `lib/search/query.ts` (Task 1).
- Produces:
  ```ts
  export type QualityClass = 'analytical' | 'survey' | 'label' | 'crowd';
  export type Features = { lexical: number; trigram: number; brandMatch: number;
    prepStateMatch: number; userPrior: number; qualityClass: number; eatsStatus: number };
  export const WEIGHTS: Readonly<Features>;                      // sums to exactly 1.00
  export const ENERGY_MISMATCH_PENALTY: 0.25;
  export function combine(f: Features): number;                  // bounded [0,1]
  export function userPriorScore(logs90d: number): number;
  export function qualityClassScore(cls: QualityClass, flags: string[]): number;
  export function prepStateMatchScore(q: PrepState | null, row: PrepState | null): number;
  export function brandMatchScore(q: string | null, row: string | null, sim: number): number;
  export function eatsStatusScore(status: 'eats' | 'avoid' | null): number;
  export function featuresFromRow(row: { f_lexical: number; f_trigram: number; f_brand: number;
    f_prep: number; f_prior: number; f_quality: number; f_eats: number }): Features;
  ```
  These are the architecture §4.1 numbers, and contracts §2 was corrected to match them (Open question 1,
  resolved 2026-09-11): `0.35·lexical + 0.20·trigram + 0.15·brand + 0.10·prep + 0.10·prior +
  0.05·quality + 0.05·eats`; quality `analytical 1.0 / survey 0.75 / label 0.5 / crowd 0.25`, `−0.25` on
  `energy_mismatch`.

### Steps

- [ ] Write the failing test — create `lib/search/features.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import {
    brandMatchScore, combine, eatsStatusScore, ENERGY_MISMATCH_PENALTY, featuresFromRow,
    prepStateMatchScore, qualityClassScore, userPriorScore, WEIGHTS, type Features,
  } from "./features";

  const ZERO: Features = {
    lexical: 0, trigram: 0, brandMatch: 0, prepStateMatch: 0, userPrior: 0, qualityClass: 0, eatsStatus: 0,
  };

  describe("WEIGHTS", () => {
    it("sums to exactly 1.00 at four decimals", () => {
      const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
      expect(Number(sum.toFixed(4))).toBe(1);
    });

    it("carries the contracts §2 weights", () => {
      expect(WEIGHTS).toEqual({
        lexical: 0.35, trigram: 0.2, brandMatch: 0.15,
        prepStateMatch: 0.1, userPrior: 0.1, qualityClass: 0.05, eatsStatus: 0.05,
      });
    });
  });

  describe("combine", () => {
    it("is 0 for an all-zero row and 1 for an all-one row", () => {
      expect(combine(ZERO)).toBe(0);
      const ones = Object.fromEntries(Object.keys(ZERO).map((k) => [k, 1])) as Features;
      expect(combine(ones)).toBeCloseTo(1, 10);
    });

    it("weights each feature as contracts §2 says", () => {
      expect(combine({ ...ZERO, lexical: 1 })).toBeCloseTo(0.35, 10);
      expect(combine({ ...ZERO, trigram: 1 })).toBeCloseTo(0.2, 10);
      expect(combine({ ...ZERO, brandMatch: 1 })).toBeCloseTo(0.15, 10);
      expect(combine({ ...ZERO, prepStateMatch: 1 })).toBeCloseTo(0.1, 10);
      expect(combine({ ...ZERO, userPrior: 1 })).toBeCloseTo(0.1, 10);
      expect(combine({ ...ZERO, qualityClass: 1 })).toBeCloseTo(0.05, 10);
      expect(combine({ ...ZERO, eatsStatus: 1 })).toBeCloseTo(0.05, 10);
    });

    it("stays inside [0,1] on out-of-range input", () => {
      const wild = Object.fromEntries(Object.keys(ZERO).map((k) => [k, 9])) as Features;
      expect(combine(wild)).toBe(1);
      const negative = Object.fromEntries(Object.keys(ZERO).map((k) => [k, -9])) as Features;
      expect(combine(negative)).toBe(0);
    });
  });

  describe("userPriorScore", () => {
    it("is 0 with no logs and saturates at 20", () => {
      expect(userPriorScore(0)).toBe(0);
      expect(userPriorScore(20)).toBe(1);
      expect(userPriorScore(100)).toBe(1);
    });

    it("rises with the log count", () => {
      expect(userPriorScore(1)).toBeCloseTo(Math.log(2) / Math.log(21), 10);
      expect(userPriorScore(5)).toBeGreaterThan(userPriorScore(1));
      expect(userPriorScore(5)).toBeLessThan(1);
    });
  });

  describe("qualityClassScore", () => {
    it("maps the four classes", () => {
      expect(qualityClassScore("analytical", [])).toBe(1);
      expect(qualityClassScore("survey", [])).toBe(0.75);
      expect(qualityClassScore("label", [])).toBe(0.5);
      expect(qualityClassScore("crowd", [])).toBe(0.25);
    });

    it("subtracts the mismatch penalty and floors at 0", () => {
      expect(ENERGY_MISMATCH_PENALTY).toBe(0.25);
      expect(qualityClassScore("survey", ["energy_mismatch"])).toBeCloseTo(0.5, 10);
      expect(qualityClassScore("crowd", ["energy_mismatch", "carb_basis_total"])).toBeCloseTo(0, 10);
      expect(qualityClassScore("crowd", ["energy_mismatch"])).toBeGreaterThanOrEqual(0);
    });
  });

  describe("prepStateMatchScore", () => {
    it("is 1 on a match, 0 on a conflict, 0.5 when either side is unknown", () => {
      expect(prepStateMatchScore("roasted", "roasted")).toBe(1);
      expect(prepStateMatchScore("raw", "fried")).toBe(0);
      expect(prepStateMatchScore(null, "fried")).toBe(0.5);
      expect(prepStateMatchScore("raw", null)).toBe(0.5);
      expect(prepStateMatchScore(null, null)).toBe(0.5);
    });
  });

  describe("brandMatchScore", () => {
    it("is 0 for every row when the query names no brand", () => {
      expect(brandMatchScore(null, "Kirkland", 0.9)).toBe(0);
    });

    it("is 1 on a normalised equality", () => {
      expect(brandMatchScore("kirkland", "  Kirkland ", 0.1)).toBe(1);
      expect(brandMatchScore("Café Muller", "cafe müller", 0)).toBe(1);
    });

    it("returns 0.6 once the trigram similarity clears 0.6, else 0", () => {
      expect(brandMatchScore("kirkland", "Kirklands Best", 0.72)).toBe(0.6);
      expect(brandMatchScore("kirkland", "Kirklands Best", 0.6)).toBe(0.6);
      expect(brandMatchScore("kirkland", "Kirklands Best", 0.59)).toBe(0);
      expect(brandMatchScore("kirkland", null, 0)).toBe(0);
      expect(brandMatchScore("kirkland", "other", 4)).toBe(0.6);
    });
  });

  describe("eatsStatusScore", () => {
    it("is 1 eats, 0 avoid, 0.5 unknown", () => {
      expect(eatsStatusScore("eats")).toBe(1);
      expect(eatsStatusScore("avoid")).toBe(0);
      expect(eatsStatusScore(null)).toBe(0.5);
    });
  });

  describe("featuresFromRow", () => {
    it("maps the RPC feature columns onto Features", () => {
      expect(
        featuresFromRow({
          f_lexical: 0.4, f_trigram: 0.3, f_brand: 0, f_prep: 0.5,
          f_prior: 0.1, f_quality: 1, f_eats: 0.5,
        })
      ).toEqual({
        lexical: 0.4, trigram: 0.3, brandMatch: 0, prepStateMatch: 0.5,
        userPrior: 0.1, qualityClass: 1, eatsStatus: 0.5,
      });
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/search/features.test.ts
  ```
  Expected: `Cannot find module '.../lib/search/features'`.

- [ ] Write `lib/search/features.ts`:
  ```ts
  /**
   * The architecture §4.1 search score, in TypeScript.
   *
   * `supabase/migrations/20260912090100_catalog_search.sql` carries the same
   * arithmetic and returns its seven feature columns, so `combine(featuresFromRow(hit))`
   * reproduces the SQL `score` on the same inputs. `tests/search/score-parity.test.ts`
   * holds the two together.
   *
   * The numbers are the frozen ones in docs/plans/2026-09-11-phase-1-2/00-contracts.md §2, corrected
   * 2026-09-11 to match architecture §4.1 exactly (Open question 1).
   */

  import { normalizeBrand, type PrepState } from "./query";

  export type QualityClass = "analytical" | "survey" | "label" | "crowd";

  export type Features = {
    lexical: number;
    trigram: number;
    brandMatch: number;
    prepStateMatch: number;
    userPrior: number;
    qualityClass: number;
    eatsStatus: number;
  };

  export const WEIGHTS: Readonly<Features> = Object.freeze({
    lexical: 0.35,
    trigram: 0.2,
    brandMatch: 0.15,
    prepStateMatch: 0.1,
    userPrior: 0.1,
    qualityClass: 0.05,
    eatsStatus: 0.05,
  });

  export const ENERGY_MISMATCH_PENALTY = 0.25;

  /** 20 logs in 90 days saturates the prior. */
  const PRIOR_SATURATION = 21;

  /** similarity() at or above this clears the brand fallback match. */
  const BRAND_SIMILARITY_THRESHOLD = 0.6;

  const QUALITY: Readonly<Record<QualityClass, number>> = Object.freeze({
    analytical: 1,
    survey: 0.75,
    label: 0.5,
    crowd: 0.25,
  });

  function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
  }

  export function combine(f: Features): number {
    const sum =
      WEIGHTS.lexical * f.lexical +
      WEIGHTS.trigram * f.trigram +
      WEIGHTS.brandMatch * f.brandMatch +
      WEIGHTS.prepStateMatch * f.prepStateMatch +
      WEIGHTS.userPrior * f.userPrior +
      WEIGHTS.qualityClass * f.qualityClass +
      WEIGHTS.eatsStatus * f.eatsStatus;
    return clamp01(sum);
  }

  export function userPriorScore(logs90d: number): number {
    if (!(logs90d > 0)) return 0;
    return Math.min(1, Math.log(1 + logs90d) / Math.log(PRIOR_SATURATION));
  }

  export function qualityClassScore(cls: QualityClass, flags: string[]): number {
    const base = QUALITY[cls] ?? 0;
    const penalty = flags.includes("energy_mismatch") ? ENERGY_MISMATCH_PENALTY : 0;
    return Math.max(0, base - penalty);
  }

  export function prepStateMatchScore(q: PrepState | null, row: PrepState | null): number {
    if (q === null || row === null) return 0.5;
    return q === row ? 1 : 0;
  }

  export function brandMatchScore(q: string | null, row: string | null, sim: number): number {
    if (q === null) return 0;
    if (row !== null && normalizeBrand(q) === normalizeBrand(row)) return 1;
    return sim >= BRAND_SIMILARITY_THRESHOLD ? BRAND_SIMILARITY_THRESHOLD : 0;
  }

  export function eatsStatusScore(status: "eats" | "avoid" | null): number {
    if (status === "eats") return 1;
    if (status === "avoid") return 0;
    return 0.5;
  }

  export function featuresFromRow(row: {
    f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
    f_prior: number; f_quality: number; f_eats: number;
  }): Features {
    return {
      lexical: row.f_lexical,
      trigram: row.f_trigram,
      brandMatch: row.f_brand,
      prepStateMatch: row.f_prep,
      userPrior: row.f_prior,
      qualityClass: row.f_quality,
      eatsStatus: row.f_eats,
    };
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/search/features.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  15 passed`.

- [ ] Commit:
  ```bash
  git add lib/search/features.ts lib/search/features.test.ts
  git commit -m "feat: mirror the catalog search score in TypeScript"
  ```

---

## Task 3 — Auto-resolve thresholds

**Files**
- Create: `lib/search/thresholds.ts`
- Test: `lib/search/thresholds.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces:
  ```ts
  export type AutoResolveThreshold = { minScore: number; minMargin: number };
  export const AUTO_RESOLVE: Record<'branded' | 'generic', AutoResolveThreshold>;
  export function shouldAutoResolve(hits: { score: number }[], cls: 'branded' | 'generic'): boolean;
  ```
  `hits` is assumed already ordered by score descending — that is what `catalog_search` returns.

### Steps

- [ ] Write the failing test — create `lib/search/thresholds.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { AUTO_RESOLVE, shouldAutoResolve } from "./thresholds";

  const cls = "generic" as const;

  describe("AUTO_RESOLVE", () => {
    it("carries a branded and a generic pair, both inside [0,1]", () => {
      for (const key of ["branded", "generic"] as const) {
        expect(AUTO_RESOLVE[key].minScore).toBeGreaterThan(0);
        expect(AUTO_RESOLVE[key].minScore).toBeLessThanOrEqual(1);
        expect(AUTO_RESOLVE[key].minMargin).toBeGreaterThanOrEqual(0);
        expect(AUTO_RESOLVE[key].minMargin).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("shouldAutoResolve", () => {
    const { minScore, minMargin } = AUTO_RESOLVE[cls];

    it("never auto-resolves a single hit", () => {
      expect(shouldAutoResolve([{ score: 0.99 }], cls)).toBe(false);
    });

    it("never auto-resolves an empty result", () => {
      expect(shouldAutoResolve([], cls)).toBe(false);
    });

    it("needs the score as well as the margin", () => {
      expect(shouldAutoResolve([{ score: minScore - 0.01 }, { score: 0 }], cls)).toBe(false);
    });

    it("needs the margin as well as the score", () => {
      expect(
        shouldAutoResolve([{ score: minScore }, { score: minScore - (minMargin - 0.01) }], cls)
      ).toBe(false);
    });

    it("auto-resolves when both clear", () => {
      expect(shouldAutoResolve([{ score: minScore }, { score: minScore - minMargin }], cls)).toBe(true);
    });

    it("reads the threshold of the class it is given", () => {
      const top = { score: 1 };
      const second = { score: 1 - AUTO_RESOLVE.branded.minMargin };
      expect(shouldAutoResolve([top, second], "branded")).toBe(true);
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/search/thresholds.test.ts
  ```
  Expected: `Cannot find module '.../lib/search/thresholds'`.

- [ ] Write `lib/search/thresholds.ts`:
  ```ts
  /**
   * Auto-resolve thresholds for AI grounding (architecture §4.1).
   *
   * GENERATED SECTION — the numbers below are the provisional pair. At the end of
   * Phase 1 `pnpm exec tsx scripts/search-eval.ts` rewrites this file with the
   * values calibrated on docs/catalog/labelled-queries.jsonl (Phase 1 acceptance
   * criterion 9). Do not hand-edit the numbers; rerun the eval.
   */

  export type AutoResolveThreshold = { minScore: number; minMargin: number };

  export const AUTO_RESOLVE: Record<"branded" | "generic", AutoResolveThreshold> = {
    branded: { minScore: 0.8, minMargin: 0.15 },
    generic: { minScore: 0.8, minMargin: 0.15 },
  };

  /** `hits` must already be ordered by score descending — `catalog_search` returns them that way. */
  export function shouldAutoResolve(hits: { score: number }[], cls: "branded" | "generic"): boolean {
    if (hits.length < 2) return false;
    const t = AUTO_RESOLVE[cls];
    return hits[0].score >= t.minScore && hits[0].score - hits[1].score >= t.minMargin;
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/search/thresholds.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  7 passed`.

- [ ] Commit:
  ```bash
  git add lib/search/thresholds.ts lib/search/thresholds.test.ts
  git commit -m "feat: add provisional auto-resolve thresholds for catalog search"
  ```

---

## Task 4 — GTIN-14 normalisation

**Files**
- Create: `lib/search/gtin.ts`
- Test: `lib/search/gtin.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces: `export function toGtin14(raw: string): string | null;`
  The import normalises GTINs in Phase 1; barcode lookup arrives in Phase 3 (architecture §4.1).

### Steps

- [ ] Write the failing test — create `lib/search/gtin.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { toGtin14 } from "./gtin";

  describe("toGtin14", () => {
    it("pads an EAN-13 to fourteen digits", () => {
      expect(toGtin14("4006381333931")).toBe("04006381333931");
    });

    it("pads a UPC-A to fourteen digits", () => {
      expect(toGtin14("036000291452")).toBe("00036000291452");
    });

    it("pads an EAN-8 to fourteen digits", () => {
      expect(toGtin14("96385074")).toBe("00000096385074");
    });

    it("passes an already-14 code through", () => {
      expect(toGtin14("00036000291452")).toBe("00036000291452");
    });

    it("ignores spaces and hyphens", () => {
      expect(toGtin14(" 0-36000 29145 2 ")).toBe("00036000291452");
    });

    it("returns null on a bad check digit", () => {
      expect(toGtin14("036000291453")).toBeNull();
      expect(toGtin14("4006381333930")).toBeNull();
    });

    it("returns null on a length no GTIN uses", () => {
      expect(toGtin14("12345")).toBeNull();
      expect(toGtin14("123456789012345")).toBeNull();
      expect(toGtin14("")).toBeNull();
    });

    it("returns null for an all-zero code", () => {
      expect(toGtin14("00000000")).toBeNull();
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/search/gtin.test.ts
  ```
  Expected: `Cannot find module '.../lib/search/gtin'`.

- [ ] Write `lib/search/gtin.ts`:
  ```ts
  /**
   * GS1 GTIN-14 normalisation (architecture §3.1: "GTIN is normalised to GTIN-14
   * with check-digit validation"). EAN-8, UPC-A and EAN-13 left-pad with zeros;
   * the mod-10 check digit is verified against the padded form, so every accepted
   * value is a single comparable key for `catalog_barcodes.gtin14`.
   */

  const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

  export function toGtin14(raw: string): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (!GTIN_LENGTHS.has(digits.length)) return null;
    const padded = digits.padStart(14, "0");
    if (/^0{14}$/.test(padded)) return null;
    let sum = 0;
    for (let i = 0; i < 13; i += 1) {
      sum += Number(padded[i]) * (i % 2 === 0 ? 3 : 1);
    }
    const check = (10 - (sum % 10)) % 10;
    return check === Number(padded[13]) ? padded : null;
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/search/gtin.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  8 passed`.

- [ ] Commit:
  ```bash
  git add lib/search/gtin.ts lib/search/gtin.test.ts
  git commit -m "feat: normalise barcodes to GTIN-14 with a check digit"
  ```

---

## Task 5 — The server catalog module

**Files**
- Create: `lib/server/catalog.ts`
- Test: `lib/server/catalog.test.ts`

**Interfaces**
- Consumes (Phase 0 contracts §5, Lane B):
  ```ts
  export class HttpError extends Error { constructor(public status: number, public code: string, message?: string) }
  ```
  from `@/lib/server/auth`; `PrepState`, `parseQuery`, `classifyQuery` from `@/lib/search/query`;
  `QualityClass` from `@/lib/search/features`; `shouldAutoResolve` from `@/lib/search/thresholds`;
  the `catalog_search` RPC of Task 7.
- Produces (contracts §3 — exactly the Phase 1 spec wire types):
  ```ts
  export type CatalogSource = 'fdc_foundation'|'fdc_sr_legacy'|'fdc_fndds'|'fdc_branded'|'off';
  export type FoodSearchRequest = { q: string; brand?: string; prep?: PrepState; limit?: number };
  export type FoodSearchHit = { catalogFoodId: number; revisionId: number; description: string;
    brand: string | null; source: CatalogSource; qualityClass: QualityClass; qualityFlags: string[];
    prepState: PrepState | null; score: number; prefStatus: 'eats' | 'avoid' | null };
  export type FoodSearchResponse = { hits: FoodSearchHit[]; queryClass: 'branded' | 'generic';
    autoResolve: { revisionId: number; score: number; margin: number } | null; catalogVersion: string };
  export type FoodDetail = FoodSearchHit & { category: string | null; catalogVersion: string;
    attribution: string; per100g: Record<string, { amount: number | null; unit: string }>;
    portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
    ingredients: { seq: number; name: string; allergenTags: string[] }[] };
  export class NoActiveCatalogVersion extends HttpError {}      // 503 'catalog_unavailable'
  export function attributionFor(source: CatalogSource, versionLabel: string): string;
  export function clientIp(req: Request): string;
  export function withRetryAfter(res: Response, seconds: number): Response;
  export async function activeVersionLabel(client: SupabaseClient): Promise<string>;
  export async function searchFoods(client: SupabaseClient, req: FoodSearchRequest): Promise<FoodSearchResponse>;
  export async function getFoodDetail(client: SupabaseClient, id: number): Promise<FoodDetail>;
  ```

### Steps

- [ ] Write the failing test — create `lib/server/catalog.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import {
    attributionFor, clientIp, getFoodDetail, NoActiveCatalogVersion, searchFoods, withRetryAfter,
  } from "./catalog";

  const VERSION = { data: { version_label: "fdc-2026-09" }, error: null };
  const NO_VERSION = { data: null, error: null };

  const ROW = {
    catalog_food_id: 7, revision_id: 70, description: "Chicken, breast, roasted", brand: null,
    source: "fdc_sr_legacy", quality_class: "analytical", quality_flags: [], prep_state: "roasted",
    score: 0.8123, pref_status: "eats",
    f_lexical: 0.9, f_trigram: 0.62, f_brand: 0, f_prep: 1, f_prior: 0.5, f_quality: 1, f_eats: 1,
  };

  /** A Supabase client with just the surface `lib/server/catalog.ts` uses. */
  function clientWith(opts: { version?: unknown; rpc?: unknown; revision?: unknown; pref?: unknown }) {
    const rpc = vi.fn().mockResolvedValue(opts.rpc ?? { data: [], error: null });
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = vi.fn(self);
      chain.maybeSingle = vi.fn().mockResolvedValue(
        table === "catalog_versions" ? (opts.version ?? VERSION)
          : table === "food_refs" ? (opts.pref ?? { data: null, error: null })
          : (opts.revision ?? { data: null, error: null })
      );
      return chain;
    });
    return { rpc, from } as never;
  }

  describe("attributionFor", () => {
    it("names Open Food Facts and the ODbL", () => {
      expect(attributionFor("off", "2026-09-01")).toBe("Data from Open Food Facts (ODbL)");
    });
    it("names the USDA source and the version label", () => {
      expect(attributionFor("fdc_sr_legacy", "fdc-2026-09")).toBe(
        "USDA FoodData Central — SR Legacy (fdc-2026-09)"
      );
    });
  });

  describe("clientIp", () => {
    it("takes the first hop of x-forwarded-for", () => {
      const req = new Request("https://a.test/x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
      expect(clientIp(req)).toBe("1.2.3.4");
    });
    it("falls back to a constant when the header is absent", () => {
      expect(clientIp(new Request("https://a.test/x"))).toBe("unknown");
    });
  });

  describe("withRetryAfter", () => {
    it("copies status and body and adds the header", async () => {
      const res = withRetryAfter(new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }), 60);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toEqual({ error: "rate_limited" });
    });
  });

  describe("searchFoods", () => {
    it("503s when no catalog version is active", async () => {
      await expect(searchFoods(clientWith({ version: NO_VERSION }), { q: "chicken" }))
        .rejects.toBeInstanceOf(NoActiveCatalogVersion);
    });

    it("passes the parsed query, brand, prep and a clamped limit to the RPC", async () => {
      const client = clientWith({ rpc: { data: [ROW], error: null } });
      await searchFoods(client, { q: "chicken thigh roasted brand:Kirkland", limit: 99 });
      expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
        "catalog_search",
        { p_q: "chicken thigh", p_brand: "Kirkland", p_prep: "roasted", p_limit: 25 }
      );
    });

    it("maps RPC rows onto the wire shape and reports the query class and version", async () => {
      const res = await searchFoods(clientWith({ rpc: { data: [ROW], error: null } }), { q: "chicken" });
      expect(res.catalogVersion).toBe("fdc-2026-09");
      expect(res.queryClass).toBe("generic");
      expect(res.hits).toEqual([{
        catalogFoodId: 7, revisionId: 70, description: "Chicken, breast, roasted", brand: null,
        source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
        score: 0.8123, prefStatus: "eats",
      }]);
    });

    it("reports no auto-resolve on a single hit", async () => {
      const res = await searchFoods(clientWith({ rpc: { data: [ROW], error: null } }), { q: "chicken" });
      expect(res.autoResolve).toBeNull();
    });

    it("reports an auto-resolve with its margin when the top two clear the threshold", async () => {
      const rows = [{ ...ROW, score: 0.95 }, { ...ROW, revision_id: 71, score: 0.5 }];
      const res = await searchFoods(clientWith({ rpc: { data: rows, error: null } }), { q: "chicken" });
      expect(res.autoResolve).toEqual({ revisionId: 70, score: 0.95, margin: 0.45 });
    });

    it("turns an RPC error into a 500 without the SQL text", async () => {
      const client = clientWith({ rpc: { data: null, error: { message: 'relation "x" does not exist' } } });
      await expect(searchFoods(client, { q: "chicken" })).rejects.toMatchObject({
        status: 500, code: "search_failed",
      });
      await expect(searchFoods(client, { q: "chicken" })).rejects.not.toThrow(/relation/);
    });
  });

  describe("getFoodDetail", () => {
    it("404s on an unknown or inactive catalog food", async () => {
      await expect(getFoodDetail(clientWith({}), 404)).rejects.toMatchObject({
        status: 404, code: "not_found",
      });
    });

    it("503s when no catalog version is active", async () => {
      await expect(getFoodDetail(clientWith({ version: NO_VERSION }), 7))
        .rejects.toBeInstanceOf(NoActiveCatalogVersion);
    });

    it("assembles per-100 g values, portions, ingredients and the attribution", async () => {
      const revision = { data: {
        id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
        category: "Poultry Products", prep_state: "roasted", quality_class: "analytical",
        quality_flags: [],
        catalog_foods: { source: "fdc_sr_legacy" },
        catalog_food_nutrients: [
          { nutrient_code: "protein", amount_per_100g: 31, catalog_nutrients: { unit: "g" } },
          { nutrient_code: "vitamin_d", amount_per_100g: null, catalog_nutrients: { unit: "µg" } },
        ],
        catalog_portions: [{ id: 5, description: "3 oz", gram_weight: 85, is_default: true, seq: 1 }],
        catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [] }],
      }, error: null };
      const detail = await getFoodDetail(clientWith({ revision, pref: { data: { user_food_prefs: [{ status: "avoid" }] }, error: null } }), 7);
      expect(detail.per100g).toEqual({
        protein: { amount: 31, unit: "g" },
        vitamin_d: { amount: null, unit: "µg" },
      });
      expect(detail.portions).toEqual([{ id: 5, description: "3 oz", gramWeight: 85, isDefault: true }]);
      expect(detail.ingredients).toEqual([{ seq: 1, name: "chicken", allergenTags: [] }]);
      expect(detail.attribution).toBe("USDA FoodData Central — SR Legacy (fdc-2026-09)");
      expect(detail.prefStatus).toBe("avoid");
      expect(detail.score).toBe(0);
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/server/catalog.test.ts
  ```
  Expected: `Cannot find module '.../lib/server/catalog'`.

- [ ] Write `lib/server/catalog.ts`:
  ```ts
  /**
   * Server-only catalog reads. The only module app/api/foods/* talks to.
   *
   * Every query runs on the RLS-scoped, request-local client `requireUser`
   * returns — never the service role. `catalog_search` is `security invoker`, so
   * the personalised half of the score (the 90-day prior count and the eats/avoid
   * status) is the caller's own rows and nobody else's.
   */

  import "server-only";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { QualityClass } from "@/lib/search/features";
  import { classifyQuery, parseQuery, type PrepState } from "@/lib/search/query";
  import { shouldAutoResolve } from "@/lib/search/thresholds";
  import { HttpError } from "@/lib/server/auth";

  export type CatalogSource = "fdc_foundation" | "fdc_sr_legacy" | "fdc_fndds" | "fdc_branded" | "off";

  export type FoodSearchRequest = { q: string; brand?: string; prep?: PrepState; limit?: number };

  export type FoodSearchHit = {
    catalogFoodId: number; revisionId: number; description: string; brand: string | null;
    source: CatalogSource; qualityClass: QualityClass; qualityFlags: string[];
    prepState: PrepState | null; score: number; prefStatus: "eats" | "avoid" | null;
  };

  export type FoodSearchResponse = {
    hits: FoodSearchHit[];
    queryClass: "branded" | "generic";
    autoResolve: { revisionId: number; score: number; margin: number } | null;
    catalogVersion: string;
  };

  export type FoodDetail = FoodSearchHit & {
    category: string | null; catalogVersion: string; attribution: string;
    per100g: Record<string, { amount: number | null; unit: string }>;
    portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
    ingredients: { seq: number; name: string; allergenTags: string[] }[];
  };

  /** No active `catalog_versions` row: the client falls back to the bundled database. */
  export class NoActiveCatalogVersion extends HttpError {
    constructor() {
      super(503, "catalog_unavailable", "The food catalog is not available right now.");
    }
  }

  const SOURCE_LABEL: Record<CatalogSource, string> = {
    fdc_foundation: "Foundation Foods",
    fdc_sr_legacy: "SR Legacy",
    fdc_fndds: "FNDDS",
    fdc_branded: "Branded Foods",
    off: "Open Food Facts",
  };

  export function attributionFor(source: CatalogSource, versionLabel: string): string {
    if (source === "off") return "Data from Open Food Facts (ODbL)";
    return `USDA FoodData Central — ${SOURCE_LABEL[source]} (${versionLabel})`;
  }

  export function clientIp(req: Request): string {
    const header = req.headers.get("x-forwarded-for");
    const first = header?.split(",")[0]?.trim();
    return first && first.length > 0 ? first : "unknown";
  }

  export function withRetryAfter(res: Response, seconds: number): Response {
    const headers = new Headers(res.headers);
    headers.set("retry-after", String(seconds));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  type SearchRow = {
    catalog_food_id: number; revision_id: number; description: string; brand: string | null;
    source: CatalogSource; quality_class: QualityClass; quality_flags: string[];
    prep_state: PrepState | null; score: number; pref_status: "eats" | "avoid" | null;
  };

  function toHit(row: SearchRow): FoodSearchHit {
    return {
      catalogFoodId: row.catalog_food_id,
      revisionId: row.revision_id,
      description: row.description,
      brand: row.brand,
      source: row.source,
      qualityClass: row.quality_class,
      qualityFlags: row.quality_flags ?? [],
      prepState: row.prep_state,
      score: row.score,
      prefStatus: row.pref_status,
    };
  }

  export async function activeVersionLabel(client: SupabaseClient): Promise<string> {
    const { data, error } = await client
      .from("catalog_versions")
      .select("version_label")
      .eq("is_active", true)
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) throw new NoActiveCatalogVersion();
    return (data as { version_label: string }).version_label;
  }

  export async function searchFoods(
    client: SupabaseClient,
    req: FoodSearchRequest
  ): Promise<FoodSearchResponse> {
    const catalogVersion = await activeVersionLabel(client);
    const parsed = parseQuery(req.q);
    const brand = req.brand ?? parsed.brand;
    const prep = req.prep && req.prep !== "unknown" ? req.prep : parsed.prep;
    const limit = Math.min(25, Math.max(1, req.limit ?? 25));
    const { data, error } = await client.rpc("catalog_search", {
      p_q: parsed.raw,
      p_brand: brand ?? null,
      p_prep: prep ?? null,
      p_limit: limit,
    });
    if (error) throw new HttpError(500, "search_failed", "Search is unavailable right now.");
    const hits = ((data ?? []) as SearchRow[]).map(toHit);
    const queryClass = classifyQuery({ ...parsed, brand: brand ?? null });
    const autoResolve = shouldAutoResolve(hits, queryClass)
      ? {
          revisionId: hits[0].revisionId,
          score: hits[0].score,
          margin: Number((hits[0].score - hits[1].score).toFixed(4)),
        }
      : null;
    return { hits, queryClass, autoResolve, catalogVersion };
  }

  const DETAIL_SELECT = `
    id, catalog_food_id, description, brand, category, prep_state, quality_class, quality_flags,
    catalog_foods!inner ( source ),
    catalog_food_nutrients ( nutrient_code, amount_per_100g, catalog_nutrients ( unit ) ),
    catalog_portions ( id, description, gram_weight, is_default, seq ),
    catalog_ingredients ( seq, name, allergen_tags )`;

  type DetailRow = {
    id: number; catalog_food_id: number; description: string; brand: string | null;
    category: string | null; prep_state: PrepState | null; quality_class: QualityClass;
    quality_flags: string[]; catalog_foods: { source: CatalogSource };
    catalog_food_nutrients: {
      nutrient_code: string; amount_per_100g: number | null; catalog_nutrients: { unit: string } | null;
    }[];
    catalog_portions: { id: number; description: string; gram_weight: number; is_default: boolean; seq: number }[];
    catalog_ingredients: { seq: number; name: string; allergen_tags: string[] }[];
  };

  async function prefStatusFor(
    client: SupabaseClient,
    catalogFoodId: number
  ): Promise<"eats" | "avoid" | null> {
    const { data } = await client
      .from("food_refs")
      .select("user_food_prefs ( status )")
      .eq("catalog_food_id", catalogFoodId)
      .maybeSingle();
    const prefs = (data as { user_food_prefs?: { status: "eats" | "avoid" }[] } | null)?.user_food_prefs;
    return prefs && prefs.length > 0 ? prefs[0].status : null;
  }

  export async function getFoodDetail(client: SupabaseClient, id: number): Promise<FoodDetail> {
    const catalogVersion = await activeVersionLabel(client);
    const { data, error } = await client
      .from("catalog_food_revisions")
      .select(DETAIL_SELECT)
      .eq("catalog_food_id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw new HttpError(500, "detail_failed", "That food could not be read right now.");
    if (!data) throw new HttpError(404, "not_found", "No active revision for that food.");
    const row = data as unknown as DetailRow;
    const per100g: FoodDetail["per100g"] = {};
    for (const n of row.catalog_food_nutrients ?? []) {
      per100g[n.nutrient_code] = { amount: n.amount_per_100g, unit: n.catalog_nutrients?.unit ?? "" };
    }
    return {
      catalogFoodId: row.catalog_food_id,
      revisionId: row.id,
      description: row.description,
      brand: row.brand,
      source: row.catalog_foods.source,
      qualityClass: row.quality_class,
      qualityFlags: row.quality_flags ?? [],
      prepState: row.prep_state,
      score: 0,
      prefStatus: await prefStatusFor(client, row.catalog_food_id),
      category: row.category,
      catalogVersion,
      attribution: attributionFor(row.catalog_foods.source, catalogVersion),
      per100g,
      portions: [...(row.catalog_portions ?? [])]
        .sort((a, b) => a.seq - b.seq)
        .map((p) => ({ id: p.id, description: p.description, gramWeight: p.gram_weight, isDefault: p.is_default })),
      ingredients: [...(row.catalog_ingredients ?? [])]
        .sort((a, b) => a.seq - b.seq)
        .map((i) => ({ seq: i.seq, name: i.name, allergenTags: i.allergen_tags ?? [] })),
    };
  }
  ```

  `score: 0` on a detail read is deliberate: `FoodDetail extends FoodSearchHit` and a detail read has no
  query to score against. `prefStatus` is still real — it comes from the caller's own `user_food_prefs`
  row under RLS.

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/server/catalog.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  12 passed`.

- [ ] Commit:
  ```bash
  git add lib/server/catalog.ts lib/server/catalog.test.ts
  git commit -m "feat: read the catalog through a server-only search and detail module"
  ```

---

## Task 6 — Relevance metrics and threshold calibration

**Files**
- Create: `lib/search/eval.ts`
- Test: `lib/search/eval.test.ts`

**Interfaces**
- Consumes: `classifyQuery`, `parseQuery` from `@/lib/search/query`; `AutoResolveThreshold` from
  `@/lib/search/thresholds`; `import type { CatalogSource, FoodSearchHit } from "@/lib/server/catalog"`
  (type-only, so the `server-only` import is erased and this file stays pure).
- Produces:
  ```ts
  export type LabelledQuery = { q: string; source: CatalogSource; sourceId: string; note?: string };
  export type Runs = FoodSearchHit[][];                         // one result list per labelled query
  export const MIN_PRECISION: 0.98;
  export const CALIBRATION_FALLBACK: AutoResolveThreshold;      // {0.95, 0.30} — never the provisional pair
  export function resolveLabels(labels: LabelledQuery[], byExternalId: Map<string, number>): LabelledQuery[];
  export function relevanceMetrics(l: LabelledQuery[], r: Runs):
    { n: number; top1: number; top3: number; misses: LabelledQuery[] };
  export function calibrate(l: LabelledQuery[], r: Runs): Record<'branded'|'generic', AutoResolveThreshold>;
  ```
  `docs/catalog/labelled-queries.jsonl` carries the **FDC id** in `sourceId`. `resolveLabels` swaps it for
  the `catalog_foods.id` of the imported row; a label whose id is still unresolved (`sourceId === ""`)
  is excluded from every metric and reported separately by the eval script.

### Steps

- [ ] Write the failing test — create `lib/search/eval.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import type { FoodSearchHit } from "@/lib/server/catalog";
  import { calibrate, CALIBRATION_FALLBACK, relevanceMetrics, resolveLabels, type LabelledQuery } from "./eval";

  function hit(catalogFoodId: number, score: number): FoodSearchHit {
    return {
      catalogFoodId, revisionId: catalogFoodId * 10, description: `food ${catalogFoodId}`, brand: null,
      source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: null,
      score, prefStatus: null,
    };
  }

  const label = (q: string, sourceId: string): LabelledQuery => ({ q, source: "fdc_sr_legacy", sourceId });

  describe("resolveLabels", () => {
    it("swaps the FDC id for the catalog id and blanks an unknown one", () => {
      const out = resolveLabels(
        [label("chicken", "171077"), label("beef", "999999"), label("rice", "")],
        new Map([["fdc_sr_legacy:171077", 7]])
      );
      expect(out.map((l) => l.sourceId)).toEqual(["7", "", ""]);
    });
  });

  describe("relevanceMetrics", () => {
    it("counts top-1 and top-3 over resolved labels only", () => {
      const labels = [label("a", "1"), label("b", "2"), label("c", "3"), label("d", "")];
      const runs = [
        [hit(1, 0.9), hit(9, 0.2)],
        [hit(9, 0.9), hit(2, 0.5)],
        [hit(8, 0.9), hit(7, 0.5), hit(6, 0.4), hit(3, 0.1)],
        [hit(4, 0.9)],
      ];
      const m = relevanceMetrics(labels, runs);
      expect(m.n).toBe(3);
      expect(m.top1).toBeCloseTo(1 / 3, 10);
      expect(m.top3).toBeCloseTo(2 / 3, 10);
      expect(m.misses.map((x) => x.q)).toEqual(["c"]);
    });

    it("refuses a run list of the wrong length", () => {
      expect(() => relevanceMetrics([label("a", "1")], [])).toThrow(/one run per labelled query/);
    });
  });

  describe("calibrate", () => {
    it("picks the smallest pair that reaches the precision floor", () => {
      const labels = [label("a", "1"), label("b", "2"), label("c", "3")];
      const runs = [
        [hit(1, 0.7), hit(9, 0.4)],   // correct, margin 0.30
        [hit(2, 0.62), hit(9, 0.6)],  // correct, margin 0.02
        [hit(9, 0.68), hit(3, 0.3)],  // WRONG, margin 0.38
      ];
      const out = calibrate(labels, runs);
      // A margin floor of 0.02 admits the wrong third run (score 0.68) unless the
      // score floor clears it; the smallest eligible pair keeps precision at 1.00.
      expect(out.generic.minScore + out.generic.minMargin).toBeLessThan(1);
      const top = runs.filter(
        (r) => r[0].score >= out.generic.minScore && r[0].score - r[1].score >= out.generic.minMargin
      );
      expect(top.length).toBeGreaterThan(0);
      expect(top.every((r) => r[0].catalogFoodId !== 9)).toBe(true);
    });

    it("falls back to the strict pair when nothing is eligible", () => {
      const labels = [label("a", "1"), label("b", "2")];
      const runs = [[hit(9, 0.9), hit(1, 0.1)], [hit(8, 0.9), hit(2, 0.1)]];
      expect(calibrate(labels, runs).generic).toEqual(CALIBRATION_FALLBACK);
    });

    it("calibrates branded and generic separately", () => {
      const labels = [label("Kirkland Signature oil", "1"), label("olive oil", "2")];
      const runs = [[hit(1, 0.99), hit(9, 0.1)], [hit(9, 0.99), hit(2, 0.1)]];
      const out = calibrate(labels, runs);
      expect(out.branded).not.toEqual(CALIBRATION_FALLBACK);
      expect(out.generic).toEqual(CALIBRATION_FALLBACK);
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test lib/search/eval.test.ts
  ```
  Expected: `Cannot find module '.../lib/search/eval'`.

- [ ] Write `lib/search/eval.ts`:
  ```ts
  /**
   * Relevance measurement and threshold calibration for the Phase 1 exit gate
   * (spec acceptance criteria 8 and 9). Pure: `scripts/search-eval.ts` does the
   * talking to Postgres and hands the results in here.
   */

  import { classifyQuery, parseQuery } from "./query";
  import type { AutoResolveThreshold } from "./thresholds";
  import type { CatalogSource, FoodSearchHit } from "@/lib/server/catalog";

  export type LabelledQuery = { q: string; source: CatalogSource; sourceId: string; note?: string };
  export type Runs = FoodSearchHit[][];

  /** An auto-resolve must be right at least this often for a threshold pair to be eligible. */
  export const MIN_PRECISION = 0.98;

  /** Used when no grid point clears the floor: strict enough that nothing auto-resolves. */
  export const CALIBRATION_FALLBACK: AutoResolveThreshold = { minScore: 0.95, minMargin: 0.3 };

  const resolved = (l: LabelledQuery) => l.sourceId.length > 0;

  const isCorrect = (l: LabelledQuery, h: FoodSearchHit | undefined) =>
    h !== undefined && h.source === l.source && String(h.catalogFoodId) === l.sourceId;

  export function resolveLabels(
    labels: LabelledQuery[],
    byExternalId: Map<string, number>
  ): LabelledQuery[] {
    return labels.map((l) => {
      const id = byExternalId.get(`${l.source}:${l.sourceId}`);
      return { ...l, sourceId: id === undefined ? "" : String(id) };
    });
  }

  export function relevanceMetrics(
    labels: LabelledQuery[],
    runs: Runs
  ): { n: number; top1: number; top3: number; misses: LabelledQuery[] } {
    if (labels.length !== runs.length) {
      throw new Error("relevanceMetrics: one run per labelled query");
    }
    const misses: LabelledQuery[] = [];
    let n = 0;
    let t1 = 0;
    let t3 = 0;
    for (let i = 0; i < labels.length; i += 1) {
      const l = labels[i];
      if (!resolved(l)) continue;
      n += 1;
      const hits = runs[i] ?? [];
      const at = hits.findIndex((h) => isCorrect(l, h));
      if (at === 0) t1 += 1;
      if (at >= 0 && at < 3) t3 += 1;
      else misses.push(l);
    }
    return { n, top1: n === 0 ? 0 : t1 / n, top3: n === 0 ? 0 : t3 / n, misses };
  }

  /** The search grid, ordered smallest-first: minScore 0.50–0.95 and minMargin 0.00–0.30, step 0.01. */
  function grid(): AutoResolveThreshold[] {
    const out: AutoResolveThreshold[] = [];
    for (let s = 50; s <= 95; s += 1) {
      for (let m = 0; m <= 30; m += 1) out.push({ minScore: s / 100, minMargin: m / 100 });
    }
    out.sort(
      (a, b) =>
        a.minScore + a.minMargin - (b.minScore + b.minMargin) ||
        a.minScore - b.minScore ||
        a.minMargin - b.minMargin
    );
    return out;
  }

  export function calibrate(
    labels: LabelledQuery[],
    runs: Runs
  ): Record<"branded" | "generic", AutoResolveThreshold> {
    if (labels.length !== runs.length) throw new Error("calibrate: one run per labelled query");
    const out = {
      branded: { ...CALIBRATION_FALLBACK },
      generic: { ...CALIBRATION_FALLBACK },
    };
    const points = grid();
    for (const cls of ["branded", "generic"] as const) {
      const rows = labels
        .map((l, i) => ({ l, hits: runs[i] ?? [] }))
        .filter((r) => resolved(r.l) && classifyQuery(parseQuery(r.l.q)) === cls && r.hits.length >= 2);
      for (const t of points) {
        let auto = 0;
        let correct = 0;
        for (const { l, hits } of rows) {
          if (hits[0].score < t.minScore) continue;
          if (hits[0].score - hits[1].score < t.minMargin) continue;
          auto += 1;
          if (isCorrect(l, hits[0])) correct += 1;
        }
        if (auto > 0 && correct / auto >= MIN_PRECISION) {
          out[cls] = t;
          break;
        }
      }
    }
    return out;
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test lib/search/eval.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  6 passed`.

- [ ] Commit:
  ```bash
  git add lib/search/eval.ts lib/search/eval.test.ts
  git commit -m "feat: measure search relevance and calibrate auto-resolve thresholds"
  ```

---

## Task 7 — The `catalog_search` RPC

**Files**
- Create: `supabase/migrations/20260912090100_catalog_search.sql`
- Test: `tests/search/rpc-security.test.ts` and `tests/search/score-parity.test.ts` (Tasks 13 and 14) are
  this task's real tests; both need a branch. This task's own green is the `psql` apply below.

**Interfaces**
- Consumes (Lane F, migration `20260912090000_catalog_tables.sql`): extensions `pg_trgm` and `unaccent` in
  schema `extensions`; `catalog_versions(id, version_label, is_active, imported_at)`;
  `catalog_foods(id, source)`; `catalog_food_revisions(id, catalog_food_id, catalog_version_id, description,
  brand, category, prep_state, quality_class, quality_flags, is_active, search_doc)` — `search_doc` is a
  plain `tsvector` column, written by Lane F's import worker via the immutable
  `catalog_search_doc(description, brand, category)` function (architecture §4.1); this RPC only reads
  `r.search_doc`, it never builds it inline and never assumes a generated column. The GIN indexes on
  `search_doc` and `description gin_trgm_ops`. From Phase 0: `food_refs(id, catalog_food_id)`,
  `user_food_prefs(user_id, food_ref_id, status)`, `log_entries(id, user_id, local_date, deleted_at)`,
  `log_items(entry_id, food_ref_id)`.
- Produces exactly the contracts §2 signature:
  ```sql
  create function catalog_search(p_q text, p_brand text, p_prep text, p_limit integer)
    returns table (catalog_food_id bigint, revision_id bigint, description text, brand text, source text,
                   quality_class text, quality_flags text[], prep_state text, score numeric, pref_status text,
                   f_lexical numeric, f_trigram numeric, f_brand numeric, f_prep numeric, f_prior numeric,
                   f_quality numeric, f_eats numeric);
  ```

### Steps

- [ ] **[needs branch]** Write the failing test — the function does not exist yet:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'catalog_search';"
  ```
  Expected failure: `0`. Skip condition: `SUPABASE_TEST_DB_URL` unset.

- [ ] Write `supabase/migrations/20260912090100_catalog_search.sql`:
  ```sql
  -- Lane G. Ranked catalog text search — architecture §4.1, frozen in
  -- docs/plans/2026-09-11-phase-1-2/00-contracts.md §2.
  --
  -- security invoker: auth.uid() is the caller, and RLS governs every read of
  -- user_food_prefs, log_entries and log_items. Only the caller's own prefs and
  -- log counts can move the score. A security definer variant for the privileged
  -- boundary waits for Phase 7 (Phase 1 spec, Search RPC).
  --
  -- The seven feature columns are rounded to 6 decimals and the score is computed
  -- from those rounded columns, so lib/search/features.ts combine(featuresFromRow(row))
  -- reproduces `score` exactly — tests/search/score-parity.test.ts holds them together.

  create or replace function public.catalog_search(
    p_q text,
    p_brand text default null,
    p_prep text default null,
    p_limit integer default 25
  )
  returns table (
    catalog_food_id bigint,
    revision_id bigint,
    description text,
    brand text,
    source text,
    quality_class text,
    quality_flags text[],
    prep_state text,
    score numeric,
    pref_status text,
    f_lexical numeric,
    f_trigram numeric,
    f_brand numeric,
    f_prep numeric,
    f_prior numeric,
    f_quality numeric,
    f_eats numeric
  )
  language sql
  stable
  security invoker
  set search_path = public, extensions, pg_temp
  as $$
    with q as (
      select
        websearch_to_tsquery('english', extensions.unaccent(coalesce(p_q, ''))) as tsq,
        extensions.unaccent(lower(coalesce(p_q, '')))                           as raw,
        nullif(btrim(coalesce(p_brand, '')), '')                                as qbrand,
        nullif(btrim(coalesce(p_prep, '')), '')                                 as qprep,
        auth.uid()                                                              as uid
    ),
    cand as (
      select
        r.catalog_food_id                                                        as catalog_food_id,
        r.id                                                                     as revision_id,
        r.description                                                            as description,
        r.brand                                                                  as brand,
        cf.source                                                                as source,
        r.quality_class                                                          as quality_class,
        r.quality_flags                                                          as quality_flags,
        r.prep_state                                                             as prep_state,
        pref.status                                                              as pref_status,
        round(ts_rank(r.search_doc, q.tsq, 32)::numeric, 6)           as f_lexical,
        round(extensions.similarity(r.description, q.raw)::numeric, 6)           as f_trigram,
        round(
          case
            when q.qbrand is null then 0
            when lower(extensions.unaccent(btrim(coalesce(r.brand, ''))))
               = lower(extensions.unaccent(btrim(q.qbrand)))                then 1
            when extensions.similarity(coalesce(r.brand, ''), q.qbrand) >= 0.6 then 0.6
            else 0
          end, 6)                                                                as f_brand,
        round(
          case
            when q.qprep is null or r.prep_state is null then 0.5
            when r.prep_state = q.qprep                  then 1
            else 0
          end, 6)                                                                as f_prep,
        round(least(1::numeric, ln(1 + coalesce(p.logs_90d, 0)) / ln(21::numeric)), 6) as f_prior,
        round(greatest(0::numeric,
              case r.quality_class
                when 'analytical' then 1.0 when 'survey' then 0.75
                when 'label'      then 0.5 else 0.25 end
            - case when 'energy_mismatch' = any(r.quality_flags) then 0.25 else 0 end), 6) as f_quality,
        round(
          case pref.status when 'eats' then 1 when 'avoid' then 0 else 0.5 end::numeric, 6) as f_eats
      from public.catalog_food_revisions r
      cross join q
      join public.catalog_versions v on v.id = r.catalog_version_id and v.is_active
      join public.catalog_foods    cf on cf.id = r.catalog_food_id
      left join public.food_refs   fr on fr.catalog_food_id = r.catalog_food_id
      left join public.user_food_prefs pref
             on pref.food_ref_id = fr.id and pref.user_id = q.uid
      left join lateral (
        select count(*)::numeric as logs_90d
          from public.log_items li
          join public.log_entries le on le.id = li.entry_id
         where fr.id is not null
           and li.food_ref_id = fr.id
           and le.user_id = q.uid
           and le.deleted_at is null
           and le.local_date > current_date - 90
      ) p on true
      where r.is_active
        and (r.search_doc @@ q.tsq or extensions.similarity(r.description, q.raw) > 0.25)
    )
    select
      catalog_food_id, revision_id, description, brand, source, quality_class, quality_flags, prep_state,
      round(0.35 * f_lexical + 0.20 * f_trigram + 0.15 * f_brand + 0.10 * f_prep
          + 0.10 * f_prior  + 0.05 * f_quality + 0.05 * f_eats, 4) as score,
      pref_status, f_lexical, f_trigram, f_brand, f_prep, f_prior, f_quality, f_eats
    from cand
    order by score desc, revision_id asc
    limit least(greatest(coalesce(p_limit, 25), 1), 25);
  $$;

  revoke execute on function public.catalog_search(text, text, text, integer) from public, anon;
  grant  execute on function public.catalog_search(text, text, text, integer) to authenticated, service_role;

  comment on function public.catalog_search(text, text, text, integer) is
    'Ranked catalog text search (architecture §4.1). security invoker: auth.uid() is the caller, so the user_prior and eats_status features read only the caller''s own rows.';
  ```

  Three notes on the shape, all deliberate:
  - **The prior count is guarded, not pre-limited.** `fr.id is not null` inside the lateral means the
    90-day count runs only for revisions that already have a `food_refs` row — 53 of them after the
    mapping, not the whole result set — so the exact score needs no candidate pre-limit that could drop a
    row the prior would have lifted.
  - **Active version, not just active revision.** The join to `catalog_versions` implements "only active
    revisions of the active version". It assumes every active revision points at an active version row;
    Lane F's `catalog_activate_version` is what holds that true (see Hand-off).
  - **`extensions.` qualification.** `unaccent` and `similarity` live in the `extensions`
    schema on Supabase; the pinned `search_path` plus explicit qualification keeps the function stable
    whatever the caller's own `search_path` is.
  - **`search_doc` is read, never built.** It is a plain `tsvector` column that Lane F's import worker
    populates via the immutable `catalog_search_doc(description, brand, category)` function; this RPC
    references `r.search_doc` directly and neither computes it inline nor assumes a generated column.

- [ ] **[needs branch]** Run — expect PASS:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 \
    -f supabase/migrations/20260912090100_catalog_search.sql
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'catalog_search';"
  ```
  Expected: `CREATE FUNCTION`, `REVOKE`, `GRANT`, `COMMENT`, then `f`.

- [ ] Commit:
  ```bash
  git add supabase/migrations/20260912090100_catalog_search.sql
  git commit -m "feat: add the security-invoker catalog_search RPC"
  ```

---

## Task 8 — `GET /api/foods/search`

**Files**
- Create: `app/api/foods/search/route.ts`
- Test: `tests/search/search-route.test.ts`

**Interfaces**
- Consumes: `enforceRateLimit(key, limit, windowSeconds)` from `@/lib/server/ratelimit`;
  `requireUser(req) → { userId, client }` and `HttpError` from `@/lib/server/auth`; `jsonError(e)` from
  `@/lib/server/http`; `searchFoods`, `clientIp`, `withRetryAfter` from `@/lib/server/catalog`;
  `PREP_STATES` from `@/lib/search/query`.
- Produces: `export async function GET(req: Request): Promise<Response>` returning `FoodSearchResponse`.

**Rate limiting.** §5 says 120/min/user, and contracts §8 says the limit runs before identity. Both hold
with two tiers: a coarse per-IP gate first (600/min — a flood cannot reach `getClaims()`), then the exact
per-user gate once `requireUser` has named the caller. A 429 from either carries `Retry-After: 60`, the
window length.

**Body limit.** A `GET` has no body, so the §5 8 KB cap is applied to the request URL.

### Steps

- [ ] Write the failing test — create `tests/search/search-route.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { NoActiveCatalogVersion, searchFoods } from "@/lib/server/catalog";
  import { resetRateLimits } from "@/lib/server/ratelimit";
  import { GET } from "@/app/api/foods/search/route";

  vi.mock("@/lib/server/auth", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/auth")>()),
    requireUser: vi.fn(),
  }));
  vi.mock("@/lib/server/catalog", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/catalog")>()),
    searchFoods: vi.fn(),
  }));

  const mockedUser = vi.mocked(requireUser);
  const mockedSearch = vi.mocked(searchFoods);

  const RESPONSE = { hits: [], queryClass: "generic" as const, autoResolve: null, catalogVersion: "v1" };

  function req(query: string, ip = "1.1.1.1"): Request {
    return new Request(`https://app.test/api/foods/search${query}`, {
      headers: { "x-forwarded-for": ip },
    });
  }

  beforeEach(() => {
    resetRateLimits();
    mockedUser.mockReset();
    mockedSearch.mockReset();
    mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
    mockedSearch.mockResolvedValue(RESPONSE);
  });

  describe("GET /api/foods/search", () => {
    it("returns the search response for an authenticated caller", async () => {
      const res = await GET(req("?q=chicken"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESPONSE);
      expect(mockedSearch).toHaveBeenCalledWith({}, { q: "chicken", brand: undefined, prep: undefined, limit: 25 });
    });

    it("passes brand, prep and limit through", async () => {
      await GET(req("?q=oil&brand=Kirkland&prep=roasted&limit=5"));
      expect(mockedSearch).toHaveBeenCalledWith({}, { q: "oil", brand: "Kirkland", prep: "roasted", limit: 5 });
    });

    it("401s with no session, without touching the catalog", async () => {
      mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
      const res = await GET(req("?q=chicken"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", message: "Sign in to continue." });
      expect(mockedSearch).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty q", "?q="],
      ["a missing q", ""],
      ["a q over 120 chars", `?q=${"a".repeat(121)}`],
      ["limit 0", "?q=rice&limit=0"],
      ["limit 26", "?q=rice&limit=26"],
      ["a prep outside the enum", "?q=rice&prep=sous-vide"],
    ])("400s on %s", async (_label, query) => {
      const res = await GET(req(query));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("bad_request");
      expect(mockedSearch).not.toHaveBeenCalled();
    });

    it("413s on a URL over 8 KB", async () => {
      const res = await GET(req(`?q=rice&pad=${"x".repeat(8500)}`));
      expect(res.status).toBe(413);
    });

    it("429s past 120 requests a minute, with Retry-After", async () => {
      for (let i = 0; i < 120; i += 1) expect((await GET(req("?q=rice"))).status).toBe(200);
      const res = await GET(req("?q=rice"));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect((await res.json()).error).toBe("rate_limited");
    });

    it("503s when no catalog version is active", async () => {
      mockedSearch.mockRejectedValue(new NoActiveCatalogVersion());
      const res = await GET(req("?q=chicken"));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("catalog_unavailable");
    });

    it("never echoes a SQL message on a 500", async () => {
      mockedSearch.mockRejectedValue(new Error('relation "catalog_food_revisions" does not exist'));
      const res = await GET(req("?q=chicken"));
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain("relation");
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test tests/search/search-route.test.ts
  ```
  Expected: `Cannot find module '.../app/api/foods/search/route'`.

- [ ] Write `app/api/foods/search/route.ts`:
  ```ts
  import { z } from "zod";
  import { PREP_STATES } from "@/lib/search/query";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { clientIp, searchFoods, withRetryAfter } from "@/lib/server/catalog";
  import { jsonError } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const MAX_URL_BYTES = 8 * 1024;
  const WINDOW_SECONDS = 60;

  const Query = z.object({
    q: z.string().min(1).max(120),
    brand: z.string().min(1).max(120).optional(),
    prep: z.enum(PREP_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(25).default(25),
  });

  export async function GET(req: Request): Promise<Response> {
    try {
      await enforceRateLimit(`foods:search:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
      if (Buffer.byteLength(req.url, "utf8") > MAX_URL_BYTES) {
        throw new HttpError(413, "too_large", `Request over ${MAX_URL_BYTES} bytes.`);
      }
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`foods:search:${userId}`, 120, WINDOW_SECONDS);
      const params = Object.fromEntries(new URL(req.url).searchParams);
      const parsed = Query.safeParse(params);
      if (!parsed.success) {
        throw new HttpError(400, "bad_request", "Check q, brand, prep and limit.");
      }
      const body = await searchFoods(client, parsed.data);
      return Response.json(body);
    } catch (e) {
      const res = jsonError(e);
      return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
    }
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test tests/search/search-route.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  13 passed`.

- [ ] Commit:
  ```bash
  git add app/api/foods/search/route.ts tests/search/search-route.test.ts
  git commit -m "feat: serve GET /api/foods/search over the catalog RPC"
  ```

---

## Task 9 — `GET /api/foods/[id]`

**Files**
- Create: `app/api/foods/[id]/route.ts`
- Test: `tests/search/detail-route.test.ts`

**Interfaces**
- Consumes: the same helpers as Task 8, plus `getFoodDetail(client, id)` from `@/lib/server/catalog`.
- Produces: `export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response>`
  returning `FoodDetail`. Next 16 hands route params as a promise.

### Steps

- [ ] Write the failing test — create `tests/search/detail-route.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { getFoodDetail, NoActiveCatalogVersion } from "@/lib/server/catalog";
  import { resetRateLimits } from "@/lib/server/ratelimit";
  import { GET } from "@/app/api/foods/[id]/route";

  vi.mock("@/lib/server/auth", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/auth")>()),
    requireUser: vi.fn(),
  }));
  vi.mock("@/lib/server/catalog", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/catalog")>()),
    getFoodDetail: vi.fn(),
  }));

  const mockedUser = vi.mocked(requireUser);
  const mockedDetail = vi.mocked(getFoodDetail);

  const DETAIL = {
    catalogFoodId: 7, revisionId: 70, description: "Chicken, breast, roasted", brand: null,
    source: "fdc_sr_legacy" as const, qualityClass: "analytical" as const, qualityFlags: [],
    prepState: "roasted" as const, score: 0, prefStatus: null, category: "Poultry Products",
    catalogVersion: "fdc-2026-09", attribution: "USDA FoodData Central — SR Legacy (fdc-2026-09)",
    per100g: {}, portions: [], ingredients: [],
  };

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const req = (id: string) =>
    new Request(`https://app.test/api/foods/${id}`, { headers: { "x-forwarded-for": "2.2.2.2" } });

  beforeEach(() => {
    resetRateLimits();
    mockedUser.mockReset();
    mockedDetail.mockReset();
    mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
    mockedDetail.mockResolvedValue(DETAIL);
  });

  describe("GET /api/foods/[id]", () => {
    it("returns the detail for an authenticated caller", async () => {
      const res = await GET(req("7"), ctx("7"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(DETAIL);
      expect(mockedDetail).toHaveBeenCalledWith({}, 7);
    });

    it("401s with no session", async () => {
      mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
      expect((await GET(req("7"), ctx("7"))).status).toBe(401);
      expect(mockedDetail).not.toHaveBeenCalled();
    });

    it.each([["a non-numeric id", "chicken"], ["a negative id", "-3"], ["a fractional id", "1.5"]])(
      "400s on %s",
      async (_label, id) => {
        const res = await GET(req(id), ctx(id));
        expect(res.status).toBe(400);
        expect(mockedDetail).not.toHaveBeenCalled();
      }
    );

    it("404s on an unknown or inactive food", async () => {
      mockedDetail.mockRejectedValue(new HttpError(404, "not_found", "No active revision for that food."));
      expect((await GET(req("9"), ctx("9"))).status).toBe(404);
    });

    it("503s when no catalog version is active", async () => {
      mockedDetail.mockRejectedValue(new NoActiveCatalogVersion());
      const res = await GET(req("7"), ctx("7"));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("catalog_unavailable");
    });

    it("429s past 120 requests a minute, with Retry-After", async () => {
      for (let i = 0; i < 120; i += 1) expect((await GET(req("7"), ctx("7"))).status).toBe(200);
      const res = await GET(req("7"), ctx("7"));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test tests/search/detail-route.test.ts
  ```
  Expected: `Cannot find module '.../app/api/foods/[id]/route'`.

- [ ] Write `app/api/foods/[id]/route.ts`:
  ```ts
  import { z } from "zod";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { clientIp, getFoodDetail, withRetryAfter } from "@/lib/server/catalog";
  import { jsonError } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const WINDOW_SECONDS = 60;
  const Id = z.coerce.number().int().positive();

  export async function GET(
    req: Request,
    ctx: { params: Promise<{ id: string }> }
  ): Promise<Response> {
    try {
      await enforceRateLimit(`foods:detail:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`foods:detail:${userId}`, 120, WINDOW_SECONDS);
      const raw = (await ctx.params).id;
      const parsed = Id.safeParse(raw);
      if (!parsed.success) throw new HttpError(400, "bad_request", "The food id must be a positive integer.");
      return Response.json(await getFoodDetail(client, parsed.data));
    } catch (e) {
      const res = jsonError(e);
      return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
    }
  }
  ```

- [ ] Run — expect PASS:
  ```bash
  pnpm test tests/search/detail-route.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  8 passed`.

- [ ] Commit:
  ```bash
  git add "app/api/foods/[id]/route.ts" tests/search/detail-route.test.ts
  git commit -m "feat: serve GET /api/foods/[id] with source attribution"
  ```

---

## Task 10 — The labelled query set

**Files**
- Create: `docs/catalog/labelled-queries.jsonl`
- Test: `tests/search/relevance.test.ts` (Task 16) reads it; this task's green is a shape check.

**Interfaces**
- Consumes: `LabelledQuery` from `lib/search/eval.ts` (Task 6).
- Produces: one JSON object per line, `{ q, source, sourceId, note? }`. 66 lines: her 17 seed foods and
  36 preset foods from `lib/foods.ts`, then 13 misspellings and prep-qualified forms of the queries she
  actually types. Every `sourceId` is the **FDC id**; `lib/food-db.json` carries SR descriptions and no
  FDC ids, so every line ships `sourceId: ""` with `note: "resolve after import"` and Devin fills them
  from the imported rows (Phase 1 spec, Open question 3: the script proposes, Devin corrects).

### Steps

- [ ] Write the failing test — no file yet:
  ```bash
  wc -l < docs/catalog/labelled-queries.jsonl
  ```
  Expected failure: `No such file or directory`.

- [ ] Write `docs/catalog/labelled-queries.jsonl` (66 lines, one JSON object each):
  ```jsonl
  {"q":"chicken breast","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"sirloin steak","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"ahi tuna","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"canned albacore","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"eggs","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"prosciutto","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"white rice","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"jasmine rice","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"white potato","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"sweet potato","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"butternut squash","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"banana","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"cantaloupe","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"avocado","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"avocado mayo","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"almond butter","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"olive oil","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"salmon","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"canned salmon","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"cod","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"halibut","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"shrimp","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"scallops","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"sardines","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"turkey breast","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"pork tenderloin","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"ground beef","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"bison","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"lamb loin","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"egg whites","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"pear","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"mango","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"papaya","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"honeydew","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"pineapple","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"carrot","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"pumpkin puree","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"plantain","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"cassava","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"rice noodles","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"rice cake","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"fruit pouch","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"coconut water","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"coconut oil","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"avocado oil","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"mct oil","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"macadamia nuts","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"tahini","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"sunflower butter","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"cashew butter","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"olives","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"coconut milk","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"duck fat","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"chicken thigh","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"rotisserie chicken","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"chicken thigh roasted","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"turkey breast roasted","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"white rice cooked","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"ground beef 90/10","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"chkn brst","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"sweet potatoe","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"advocado","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"bannana","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"salmom","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"cantalope","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  {"q":"almond buter","source":"fdc_sr_legacy","sourceId":"","note":"resolve after import"}
  ```

- [ ] Run — expect PASS:
  ```bash
  wc -l < docs/catalog/labelled-queries.jsonl
  node -e "const fs=require('node:fs');const ls=fs.readFileSync('docs/catalog/labelled-queries.jsonl','utf8').trim().split('\n');const seen=new Set();for(const l of ls){const o=JSON.parse(l);if(typeof o.q!=='string'||o.q.length===0)throw new Error('bad q: '+l);if(typeof o.sourceId!=='string')throw new Error('bad sourceId: '+l);if(seen.has(o.q))throw new Error('duplicate query: '+o.q);seen.add(o.q);}console.log(ls.length+' labelled queries ok');"
  ```
  Expected: `66`, then `66 labelled queries ok`.

- [ ] Commit:
  ```bash
  git add docs/catalog/labelled-queries.jsonl
  git commit -m "docs: add the labelled query set for the search relevance gate"
  ```

---

## Task 11 — `scripts/search-eval.ts`

**Files**
- Create: `scripts/search-eval.ts`
- Test: run against a branch (Step 4); the maths it calls is covered by `lib/search/eval.test.ts`.

**Interfaces**
- Consumes: `relevanceMetrics`, `calibrate`, `resolveLabels`, `LabelledQuery` from `@/lib/search/eval`;
  `parseQuery`, `classifyQuery` from `@/lib/search/query`; the `catalog_search` RPC; `createClient` from
  `@supabase/supabase-js`.
- Produces: a printed report and a rewritten `lib/search/thresholds.ts`.
  Env: `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` (contracts, Phase 0 §7) plus `SEARCH_EVAL_EMAIL` and
  `SEARCH_EVAL_PASSWORD` — the account it signs in as, because the RPC is `security invoker` and an
  anonymous caller scores every personalised feature at its neutral value.

### Steps

- [ ] Write the failing test — no script yet:
  ```bash
  pnpm exec tsx scripts/search-eval.ts --dry-run; echo "exit=$?"
  ```
  Expected failure: `Cannot find module ... scripts/search-eval.ts`, `exit=1`.

- [ ] Write `scripts/search-eval.ts`:
  ```ts
  /**
   * Runs docs/catalog/labelled-queries.jsonl through catalog_search on a Supabase
   * branch, prints top-1 and top-3, and rewrites lib/search/thresholds.ts with the
   * calibrated AUTO_RESOLVE pair (Phase 1 acceptance criteria 8 and 9).
   *
   *   pnpm exec tsx scripts/search-eval.ts [--dry-run] [--limit 25]
   *
   * Env: SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SEARCH_EVAL_EMAIL, SEARCH_EVAL_PASSWORD.
   * CI never runs this: CI has no catalog database (Phase 1 spec, Open question 4).
   */

  import { readFileSync, writeFileSync } from "node:fs";
  import { createClient, type SupabaseClient } from "@supabase/supabase-js";
  import { calibrate, relevanceMetrics, resolveLabels, type LabelledQuery, type Runs } from "@/lib/search/eval";
  import { parseQuery } from "@/lib/search/query";
  import type { FoodSearchHit } from "@/lib/server/catalog";

  const LABELS_PATH = "docs/catalog/labelled-queries.jsonl";
  const THRESHOLDS_PATH = "lib/search/thresholds.ts";
  const MIN_LABELS = 60;
  const TOP1_GATE = 0.85;
  const TOP3_GATE = 0.95;

  function env(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  function readLabels(): LabelledQuery[] {
    return readFileSync(LABELS_PATH, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LabelledQuery);
  }

  async function signIn(): Promise<SupabaseClient> {
    const client = createClient(env("SUPABASE_TEST_URL"), env("SUPABASE_TEST_ANON_KEY"));
    const { error } = await client.auth.signInWithPassword({
      email: env("SEARCH_EVAL_EMAIL"),
      password: env("SEARCH_EVAL_PASSWORD"),
    });
    if (error) throw new Error(`sign-in failed: ${error.message}`);
    return client;
  }

  async function externalIdMap(
    client: SupabaseClient,
    labels: LabelledQuery[]
  ): Promise<Map<string, number>> {
    const ids = [...new Set(labels.map((l) => l.sourceId).filter((s) => s.length > 0))];
    if (ids.length === 0) return new Map();
    const { data, error } = await client
      .from("catalog_foods")
      .select("id, source, source_id")
      .in("source_id", ids);
    if (error) throw new Error(`catalog_foods lookup failed: ${error.message}`);
    const rows = (data ?? []) as { id: number; source: string; source_id: string }[];
    return new Map(rows.map((r) => [`${r.source}:${r.source_id}`, r.id]));
  }

  async function run(client: SupabaseClient, labels: LabelledQuery[], limit: number): Promise<Runs> {
    const runs: Runs = [];
    for (const l of labels) {
      const p = parseQuery(l.q);
      const { data, error } = await client.rpc("catalog_search", {
        p_q: p.raw, p_brand: p.brand, p_prep: p.prep, p_limit: limit,
      });
      if (error) throw new Error(`catalog_search failed on "${l.q}": ${error.message}`);
      runs.push(
        ((data ?? []) as Record<string, never>[]).map(
          (r) =>
            ({
              catalogFoodId: r.catalog_food_id, revisionId: r.revision_id, description: r.description,
              brand: r.brand, source: r.source, qualityClass: r.quality_class,
              qualityFlags: r.quality_flags ?? [], prepState: r.prep_state, score: Number(r.score),
              prefStatus: r.pref_status,
            }) as unknown as FoodSearchHit
        )
      );
    }
    return runs;
  }

  function writeThresholds(t: ReturnType<typeof calibrate>): void {
    const body = `/**
   * Auto-resolve thresholds for AI grounding (architecture §4.1).
   *
   * GENERATED by \`pnpm exec tsx scripts/search-eval.ts\` from
   * docs/catalog/labelled-queries.jsonl — the smallest threshold pair that keeps
   * auto-resolve precision at or above 98 %. Do not hand-edit; rerun the eval.
   */

  export type AutoResolveThreshold = { minScore: number; minMargin: number };

  export const AUTO_RESOLVE: Record<"branded" | "generic", AutoResolveThreshold> = {
    branded: { minScore: ${t.branded.minScore}, minMargin: ${t.branded.minMargin} },
    generic: { minScore: ${t.generic.minScore}, minMargin: ${t.generic.minMargin} },
  };

  /** \`hits\` must already be ordered by score descending — \`catalog_search\` returns them that way. */
  export function shouldAutoResolve(hits: { score: number }[], cls: "branded" | "generic"): boolean {
    if (hits.length < 2) return false;
    const t = AUTO_RESOLVE[cls];
    return hits[0].score >= t.minScore && hits[0].score - hits[1].score >= t.minMargin;
  }
  `;
    writeFileSync(THRESHOLDS_PATH, body.replace(/^ {2}/gm, ""), "utf8");
  }

  async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const limitAt = argv.indexOf("--limit");
    const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : 25;

    const raw = readLabels();
    const client = await signIn();
    const labels = resolveLabels(raw, await externalIdMap(client, raw));
    const unresolved = labels.filter((l) => l.sourceId.length === 0);
    const runs = await run(client, labels, limit);
    const m = relevanceMetrics(labels, runs);

    console.log(`labelled queries : ${raw.length} (resolved ${m.n}, unresolved ${unresolved.length})`);
    console.log(`top-1            : ${(m.top1 * 100).toFixed(1)} %  (gate ${TOP1_GATE * 100} %)`);
    console.log(`top-3            : ${(m.top3 * 100).toFixed(1)} %  (gate ${TOP3_GATE * 100} %)`);
    for (const miss of m.misses) console.log(`  miss: ${miss.q}`);
    for (const u of unresolved) console.log(`  unresolved: ${u.q} (${u.source}:${raw.find((r) => r.q === u.q)?.sourceId})`);

    const thresholds = calibrate(labels, runs);
    console.log(`branded          : minScore ${thresholds.branded.minScore}, minMargin ${thresholds.branded.minMargin}`);
    console.log(`generic          : minScore ${thresholds.generic.minScore}, minMargin ${thresholds.generic.minMargin}`);

    if (!dryRun) {
      writeThresholds(thresholds);
      console.log(`wrote ${THRESHOLDS_PATH}`);
    }

    const failures: string[] = [];
    if (m.n < MIN_LABELS) failures.push(`only ${m.n} resolved labels, ${MIN_LABELS} required`);
    if (m.top1 < TOP1_GATE) failures.push(`top-1 ${(m.top1 * 100).toFixed(1)} % below the gate`);
    if (m.top3 < TOP3_GATE) failures.push(`top-3 ${(m.top3 * 100).toFixed(1)} % below the gate`);
    if (failures.length > 0) {
      for (const f of failures) console.error(`FAIL: ${f}`);
      process.exitCode = 1;
    }
  }

  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
  ```

- [ ] Run — expect PASS (the script exists and reports its missing env honestly):
  ```bash
  pnpm exec tsx scripts/search-eval.ts --dry-run; echo "exit=$?"
  ```
  Expected with no branch env: `SUPABASE_TEST_URL is not set`, `exit=1`.

- [ ] **[needs branch] [needs network]** Run for real once Lane F's import is active:
  ```bash
  pnpm exec tsx scripts/search-eval.ts
  ```
  Expected: the six report lines, `wrote lib/search/thresholds.ts`, and exit 0 once top-1 ≥ 85 % and
  top-3 ≥ 95 % over ≥ 60 resolved labels.

- [ ] Commit:
  ```bash
  git add scripts/search-eval.ts
  git commit -m "feat: measure catalog search relevance and write calibrated thresholds"
  ```

---

## Task 12 — `scripts/apply-food-mapping.ts`

**Files**
- Create: `scripts/apply-food-mapping.ts`
- Test: run against a branch (Step 4); the header and decision guards are proved by the dry-run in Step 3.

**Interfaces**
- Consumes: `adminClient()` from `@/lib/server/admin` (Phase 0 contracts §5 — the only file that reads
  `SUPABASE_SERVICE_ROLE_KEY`); `get_or_create_food_ref(p_user_id uuid, p_kind text, p_catalog_food_id
  bigint, p_user_food_id uuid) returns uuid` (Phase 0 contracts §2); `SASHA_USER_ID`;
  `docs/catalog/her-foods-mapping.csv` written by Lane F's `scripts/map-her-foods.py`, header exactly:
  ```
  user_food_id,food_name,proposed_catalog_food_id,proposed_description,proposed_source,decision,corrected_catalog_food_id,note
  ```
  `decision ∈ accept | reject`. On `accept` the id is `corrected_catalog_food_id` when it is non-empty,
  otherwise `proposed_catalog_food_id`.
- Produces: `user_foods.catalog_food_id` set and a `food_refs` row per accepted mapping. Idempotent:
  rerunning changes nothing. `--dry-run` prints the plan and writes nothing.

### Steps

- [ ] Write the failing test — no script yet:
  ```bash
  pnpm exec tsx scripts/apply-food-mapping.ts --dry-run; echo "exit=$?"
  ```
  Expected failure: `Cannot find module ... scripts/apply-food-mapping.ts`, `exit=1`.

- [ ] Write `scripts/apply-food-mapping.ts`:
  ```ts
  /**
   * Applies Devin's reviewed docs/catalog/her-foods-mapping.csv (Phase 1 spec,
   * "Her foods"): sets user_foods.catalog_food_id and creates the shared food_refs
   * row, so user_food_prefs points at the registry entry for the catalog food.
   *
   *   pnpm exec tsx scripts/apply-food-mapping.ts [--dry-run] [--csv <path>]
   *
   * Refuses to write anything while a single decision cell is blank: a half-reviewed
   * sheet is not a review. No user_foods row is deleted and per_100g is never
   * overwritten, so a wrong mapping is undone by clearing catalog_food_id and
   * rerunning.
   *
   * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (via adminClient()), SASHA_USER_ID.
   */

  import { readFileSync } from "node:fs";
  import { adminClient } from "@/lib/server/admin";

  const DEFAULT_CSV = "docs/catalog/her-foods-mapping.csv";
  const HEADER = [
    "user_food_id", "food_name", "proposed_catalog_food_id", "proposed_description",
    "proposed_source", "decision", "corrected_catalog_food_id", "note",
  ];

  type Row = Record<string, string>;

  /** RFC 4180 enough for this sheet: quoted cells, doubled quotes inside them. */
  function parseCsv(text: string): Row[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (c === '"') quoted = false;
        else cell += c;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c !== "\r") cell += c;
    }
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
    const [head, ...body] = rows.filter((r) => r.some((c) => c.trim().length > 0));
    const got = head.map((h) => h.trim());
    if (got.join(",") !== HEADER.join(",")) {
      throw new Error(`unexpected CSV header.\n  expected: ${HEADER.join(",")}\n  got:      ${got.join(",")}`);
    }
    return body.map((r) => Object.fromEntries(HEADER.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  function catalogIdFor(row: Row): number {
    const raw = row.corrected_catalog_food_id.length > 0
      ? row.corrected_catalog_food_id
      : row.proposed_catalog_food_id;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`row "${row.food_name}" is accepted with no usable catalog id ("${raw}")`);
    }
    return id;
  }

  async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const csvAt = argv.indexOf("--csv");
    const csvPath = csvAt >= 0 ? argv[csvAt + 1] : DEFAULT_CSV;

    const userId = process.env.SASHA_USER_ID;
    if (!userId) throw new Error("SASHA_USER_ID is not set");

    const rows = parseCsv(readFileSync(csvPath, "utf8"));
    const blank = rows.filter((r) => r.decision.length === 0);
    if (blank.length > 0) {
      throw new Error(
        `${blank.length} of ${rows.length} rows have no decision — review the sheet first:\n` +
          blank.map((r) => `  ${r.food_name}`).join("\n")
      );
    }
    const unknown = rows.filter((r) => !["accept", "reject"].includes(r.decision));
    if (unknown.length > 0) {
      throw new Error(`decision must be accept or reject: ${unknown.map((r) => r.decision).join(", ")}`);
    }

    const accepted = rows.filter((r) => r.decision === "accept");
    console.log(`${rows.length} rows: ${accepted.length} accept, ${rows.length - accepted.length} reject`);

    if (dryRun) {
      for (const r of accepted) console.log(`  would map ${r.food_name} → catalog_food ${catalogIdFor(r)}`);
      console.log("dry run: nothing written");
      return;
    }

    const admin = adminClient();
    for (const r of accepted) {
      const catalogFoodId = catalogIdFor(r);
      const { error: updateError } = await admin
        .from("user_foods")
        .update({ catalog_food_id: catalogFoodId })
        .eq("id", r.user_food_id)
        .eq("user_id", userId);
      if (updateError) throw new Error(`user_foods update failed for ${r.food_name}: ${updateError.message}`);

      const { data, error: refError } = await admin.rpc("get_or_create_food_ref", {
        p_user_id: userId,
        p_kind: "catalog",
        p_catalog_food_id: catalogFoodId,
        p_user_food_id: null,
      });
      if (refError) throw new Error(`get_or_create_food_ref failed for ${r.food_name}: ${refError.message}`);
      console.log(`  ${r.food_name} → catalog_food ${catalogFoodId}, food_ref ${data}`);
    }
    console.log(`applied ${accepted.length} mappings`);
  }

  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
  ```

- [ ] Run — expect PASS (the guards fire before any write):
  ```bash
  mkdir -p /tmp/smc-map && printf '%s\n' \
    'user_food_id,food_name,proposed_catalog_food_id,proposed_description,proposed_source,decision,corrected_catalog_food_id,note' \
    '11111111-1111-1111-1111-111111111111,Chicken breast,7,"Chicken, breast, roasted",fdc_sr_legacy,accept,,' \
    '22222222-2222-2222-2222-222222222222,Avocado mayo,9,"Mayonnaise, avocado oil",fdc_sr_legacy,,,label item' \
    > /tmp/smc-map/blank.csv
  SASHA_USER_ID=00000000-0000-0000-0000-000000000000 \
    pnpm exec tsx scripts/apply-food-mapping.ts --dry-run --csv /tmp/smc-map/blank.csv; echo "exit=$?"
  ```
  Expected: `1 of 2 rows have no decision — review the sheet first:`, `  Avocado mayo`, `exit=1`.
  ```bash
  sed 's/fdc_sr_legacy,,,label item/fdc_sr_legacy,reject,,label item/' /tmp/smc-map/blank.csv > /tmp/smc-map/full.csv
  SASHA_USER_ID=00000000-0000-0000-0000-000000000000 \
    pnpm exec tsx scripts/apply-food-mapping.ts --dry-run --csv /tmp/smc-map/full.csv; echo "exit=$?"
  ```
  Expected: `2 rows: 1 accept, 1 reject`, `  would map Chicken breast → catalog_food 7`,
  `dry run: nothing written`, `exit=0`.

- [ ] **[needs branch] [needs network]** After Devin signs the CSV, apply it for real:
  ```bash
  pnpm exec tsx scripts/apply-food-mapping.ts
  pnpm exec tsx scripts/apply-food-mapping.ts        # idempotent — same output, no change
  ```
  Expected: one `→ catalog_food <id>, food_ref <uuid>` line per accepted row, then
  `applied <n> mappings`, identical on the second run.

- [ ] Commit:
  ```bash
  git add scripts/apply-food-mapping.ts
  git commit -m "feat: apply the reviewed food mapping to user_foods and food_refs"
  ```

---

## Task 13 — Branch fixtures and the security-invoker proof

**Files**
- Create: `tests/search/fixtures.ts`
- Test: `tests/search/rpc-security.test.ts`

**Interfaces**
- Consumes: `SUPABASE_TEST_DB_URL` (Lane A, `scripts/db-branch.sh env`); `psql` on `PATH`.
- Produces:
  ```ts
  export const HAS_DB: boolean;                      // SUPABASE_TEST_DB_URL is set
  export function sql(statement: string): string;    // one -At result, trimmed
  export function exec(statements: string): void;    // run a script, ON_ERROR_STOP
  export function seedCatalogFixture(): void;        // the ten-row catalog used by Tasks 14–15
  export function dropCatalogFixture(): void;
  ```
  PostgREST cannot reach `pg_proc`, so the catalogue-metadata assertions go through `psql` rather than the
  Supabase client. Skip condition for every test in Tasks 13–15: `SUPABASE_TEST_DB_URL` unset (and
  `SUPABASE_TEST_URL` unset for the client-side ones).

### Steps

- [ ] Write the failing test — create `tests/search/rpc-security.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { HAS_DB, sql } from "./fixtures";

  const SIG = "public.catalog_search(text,text,text,integer)";

  describe.skipIf(!HAS_DB)("catalog_search security", () => {
    it("exists exactly once with the contracts §2 signature", () => {
      expect(
        sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'catalog_search'`)
      ).toBe("1");
      expect(sql(`select pg_get_function_identity_arguments('${SIG}'::regprocedure)`)).toBe(
        "text, text, text, integer"
      );
    });

    it("is security invoker, so RLS is the caller's", () => {
      expect(
        sql(`select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'catalog_search'`)
      ).toBe("f");
    });

    it("is executable by authenticated and by nobody anonymous", () => {
      expect(sql(`select has_function_privilege('authenticated', '${SIG}', 'execute')`)).toBe("t");
      expect(sql(`select has_function_privilege('anon', '${SIG}', 'execute')`)).toBe("f");
    });

    it("pins its search_path", () => {
      expect(
        sql(`select array_to_string(proconfig, ' ') from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'catalog_search'`)
      ).toContain("search_path=public, extensions, pg_temp");
    });
  });
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test tests/search/rpc-security.test.ts
  ```
  Expected: `Cannot find module '.../tests/search/fixtures'`.

- [ ] Write `tests/search/fixtures.ts`:
  ```ts
  /**
   * psql helpers and the shared catalog fixture for the branch-backed search tests.
   *
   * Lane F's import may not have run on the branch, so these tests bring their own
   * rows. `search_doc` is written by the worker in production; here the fixture
   * builds it with the same `catalog_search_doc()` function the migration defines.
   */

  import { execFileSync } from "node:child_process";

  const DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";
  export const HAS_DB = DB_URL.length > 0;

  export function sql(statement: string): string {
    return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", statement], {
      encoding: "utf8",
    }).trim();
  }

  export function exec(statements: string): void {
    execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", statements], {
      encoding: "utf8",
    });
  }

  /** Ten revisions across four quality classes, two prep states, one branded row. */
  export const FIXTURE_VERSION = "test-catalog-v1";

  export function seedCatalogFixture(): void {
    exec(`
      insert into catalog_versions (source, version_label, row_counts, is_active)
        values ('fdc_sr_legacy', '${FIXTURE_VERSION}', '{"revisions":10}'::jsonb, true)
        on conflict (source, version_label) do update set is_active = true;

      insert into catalog_foods (source, source_id)
        select 'fdc_sr_legacy', 'test-' || g from generate_series(1, 10) g
        on conflict (source, source_id) do nothing;

      insert into catalog_food_revisions (
        catalog_food_id, catalog_version_id, description, brand, category, prep_state,
        quality_class, quality_flags, search_doc, content_hash, is_active)
      select
        cf.id,
        (select id from catalog_versions where version_label = '${FIXTURE_VERSION}'),
        d.description, d.brand, 'Test Foods', d.prep_state, d.quality_class, d.flags,
        catalog_search_doc(d.description, d.brand, 'Test Foods'),
        'hash-' || d.n, true
      from (values
        (1,  'Chicken, breast, meat only, roasted',     null,        'roasted', 'analytical', '{}'::text[]),
        (2,  'Chicken, thigh, meat only, roasted',      null,        'roasted', 'analytical', '{}'::text[]),
        (3,  'Chicken, breast, meat and skin, fried',   null,        'fried',   'survey',     '{}'::text[]),
        (4,  'Rice, white, long-grain, cooked',         null,        'cooked',  'analytical', '{}'::text[]),
        (5,  'Rice, white, long-grain, raw',            null,        'raw',     'survey',     '{}'::text[]),
        (6,  'Sweet potato, cooked, baked in skin',     null,        'baked',   'analytical', '{}'::text[]),
        (7,  'Olive oil, extra virgin',                 'Kirkland',  null,      'label',      '{}'::text[]),
        (8,  'Olive oil, salad or cooking',             null,        null,      'analytical', '{}'::text[]),
        (9,  'Avocado, raw, California',                null,        'raw',     'analytical', '{energy_mismatch}'::text[]),
        (10, 'Avocado spread, homemade',                null,        null,      'crowd',      '{energy_mismatch}'::text[])
      ) as d(n, description, brand, prep_state, quality_class, flags)
      join catalog_foods cf on cf.source = 'fdc_sr_legacy' and cf.source_id = 'test-' || d.n
      on conflict (catalog_food_id, catalog_version_id) do nothing;
    `);
  }

  export function dropCatalogFixture(): void {
    exec(`
      delete from catalog_food_revisions r using catalog_versions v
        where v.id = r.catalog_version_id and v.version_label = '${FIXTURE_VERSION}';
      delete from catalog_foods where source = 'fdc_sr_legacy' and source_id like 'test-%';
      delete from catalog_versions where version_label = '${FIXTURE_VERSION}';
    `);
  }
  ```

- [ ] Run — expect PASS (with a branch; skipped without one):
  ```bash
  pnpm test tests/search/rpc-security.test.ts
  ```
  Expected with `SUPABASE_TEST_DB_URL` set: `Test Files  1 passed`, `Tests  4 passed`.
  Expected without it: `Test Files  1 skipped`.

- [ ] Commit:
  ```bash
  git add tests/search/fixtures.ts tests/search/rpc-security.test.ts
  git commit -m "test: prove catalog_search is security invoker and anon-denied"
  ```

---

## Task 14 — SQL/TypeScript score parity

**Files**
- Test: `tests/search/score-parity.test.ts`

**Interfaces**
- Consumes: `HAS_DB`, `sql`, `seedCatalogFixture`, `dropCatalogFixture`, `FIXTURE_VERSION` from
  `./fixtures`; `HAS_BRANCH`, `ensureUser`, `userClient`, `resetUser` from `../helpers/supabase`
  (Lane A, Phase 0); `combine`, `featuresFromRow` from `@/lib/search/features`.
- Produces: nothing.

### Steps

- [ ] Write the failing test — create `tests/search/score-parity.test.ts`:
  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { combine, featuresFromRow } from "@/lib/search/features";
  import { ensureUser, HAS_BRANCH, resetUser, userClient } from "../helpers/supabase";
  import { dropCatalogFixture, HAS_DB, seedCatalogFixture } from "./fixtures";

  const RUN = HAS_BRANCH && HAS_DB;

  type Row = {
    revision_id: number; description: string; score: number;
    f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
    f_prior: number; f_quality: number; f_eats: number;
  };

  describe.skipIf(!RUN)("catalog_search score parity", () => {
    let client: SupabaseClient;

    beforeAll(async () => {
      seedCatalogFixture();
      const a = await ensureUser("a");
      await resetUser(a.id);
      client = await userClient(a);
    });

    afterAll(() => {
      dropCatalogFixture();
    });

    async function search(q: string, brand: string | null = null, prep: string | null = null) {
      const { data, error } = await client.rpc("catalog_search", {
        p_q: q, p_brand: brand, p_prep: prep, p_limit: 25,
      });
      expect(error).toBeNull();
      return (data ?? []) as Row[];
    }

    it("returns the ten fixture rows across the queries that reach them", async () => {
      const seen = new Set<number>();
      for (const q of ["chicken", "rice", "sweet potato", "olive oil", "avocado"]) {
        for (const r of await search(q)) seen.add(r.revision_id);
      }
      expect(seen.size).toBe(10);
    });

    it("scores every returned row exactly as combine() does", async () => {
      const rows = [
        ...(await search("chicken")),
        ...(await search("rice", null, "cooked")),
        ...(await search("olive oil", "Kirkland")),
        ...(await search("avocado")),
      ];
      expect(rows.length).toBeGreaterThanOrEqual(10);
      for (const r of rows) {
        expect(combine(featuresFromRow(r))).toBeCloseTo(Number(r.score), 4);
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
      const branded = (await search("olive oil", "Kirkland")).find((r) => r.description.includes("extra virgin"));
      expect(Number(branded?.f_brand)).toBe(1);
      const plain = await search("olive oil");
      expect(plain.every((r) => Number(r.f_brand) === 0)).toBe(true);
    });

    it("scores prep match, unknown and conflict at 1, 0.5 and 0", async () => {
      const rows = await search("rice", null, "cooked");
      const cooked = rows.find((r) => r.description.includes("cooked"));
      const raw = rows.find((r) => r.description.endsWith("raw"));
      expect(Number(cooked?.f_prep)).toBe(1);
      expect(Number(raw?.f_prep)).toBe(0);
      const noPrepQuery = await search("olive oil");
      expect(noPrepQuery.every((r) => Number(r.f_prep) === 0.5)).toBe(true);
    });

    it("drops an energy_mismatch row by the architecture §4.1 penalty", async () => {
      const rows = await search("avocado");
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
  ```

- [ ] Run — expect FAIL:
  ```bash
  pnpm test tests/search/score-parity.test.ts
  ```
  Expected without the migration applied: `Could not find the function public.catalog_search`.
  Expected with no branch: `Test Files  1 skipped`.

- [ ] Apply the migration to the branch and rerun — expect PASS:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260912090100_catalog_search.sql
  pnpm test tests/search/score-parity.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  7 passed`.

- [ ] Commit:
  ```bash
  git add tests/search/score-parity.test.ts
  git commit -m "test: hold the SQL and TypeScript search scores together"
  ```

---

## Task 15 — Cross-user isolation and the Eats ordering

**Files**
- Test: `tests/search/cross-user.test.ts`

**Interfaces**
- Consumes: `createTestUsers` from `../helpers/supabase` (Lane A: both slots come back signed in);
  `exec`, `sql`, `seedCatalogFixture`, `dropCatalogFixture`, `HAS_DB` from `./fixtures`.
- Produces: nothing. This is the Phase 1 spec's integration cases 4 and 5, and the §5 denial test both
  routes are required to carry.

### Steps

- [ ] Write the failing test — create `tests/search/cross-user.test.ts`:
  ```ts
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { dropCatalogFixture, exec, HAS_DB, seedCatalogFixture, sql } from "./fixtures";

  const RUN = HAS_BRANCH && HAS_DB;

  type Row = { revision_id: number; description: string; score: number; f_prior: number; f_eats: number };

  describe.skipIf(!RUN)("catalog_search is the caller's own view", () => {
    let a: SupabaseClient;
    let b: SupabaseClient;
    let chickenBreastFoodId: string;

    beforeAll(async () => {
      seedCatalogFixture();
      const users = await createTestUsers();
      a = users.a.client;
      b = users.b.client;
      chickenBreastFoodId = sql(`
        select cf.id::text from catalog_foods cf
          where cf.source = 'fdc_sr_legacy' and cf.source_id = 'test-1'`);

      // User A: one food_ref, Eats on the roasted breast, five logs inside 90 days.
      exec(`
        insert into food_refs (kind, catalog_food_id) values ('catalog', ${chickenBreastFoodId})
          on conflict do nothing;
        insert into user_food_prefs (user_id, food_ref_id, status)
          select '${users.a.userId}', fr.id, 'eats' from food_refs fr
           where fr.catalog_food_id = ${chickenBreastFoodId}
          on conflict (user_id, food_ref_id) do update set status = 'eats';
        insert into user_food_prefs (user_id, food_ref_id, status)
          select '${users.b.userId}', fr.id, 'avoid' from food_refs fr
           where fr.catalog_food_id = ${chickenBreastFoodId}
          on conflict (user_id, food_ref_id) do update set status = 'avoid';
        insert into log_entries (id, user_id, eaten_at, tz, local_date, slot, method)
          select gen_random_uuid(), '${users.a.userId}', now(), 'America/New_York',
                 current_date - g, 'meal1', 'search'
            from generate_series(1, 5) g;
        insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot)
          select gen_random_uuid(), le.id, 1, 1, 'g', fr.id, 100, '{}'::jsonb
            from log_entries le
            cross join food_refs fr
           where le.user_id = '${users.a.userId}' and fr.catalog_food_id = ${chickenBreastFoodId};
      `);
    });

    afterAll(() => {
      exec(`
        delete from log_items li using log_entries le where le.id = li.entry_id;
        delete from log_entries;
        delete from user_food_prefs;
        delete from food_refs where catalog_food_id is not null;
      `);
      dropCatalogFixture();
    });

    async function search(client: SupabaseClient): Promise<Row[]> {
      const { data, error } = await client.rpc("catalog_search", {
        p_q: "chicken", p_brand: null, p_prep: null, p_limit: 25,
      });
      expect(error).toBeNull();
      return (data ?? []) as Row[];
    }

    it("gives user A her own prior and Eats status", async () => {
      const row = (await search(a)).find((r) => r.description.includes("breast, meat only"));
      expect(Number(row?.f_eats)).toBe(1);
      expect(Number(row?.f_prior)).toBeCloseTo(Math.log(6) / Math.log(21), 4);
    });

    it("never leaks A's log count or Eats status into B's search", async () => {
      const row = (await search(b)).find((r) => r.description.includes("breast, meat only"));
      expect(Number(row?.f_prior)).toBe(0);
      expect(Number(row?.f_eats)).toBe(0);      // B has it on Avoid, not A's Eats
    });

    it("ranks an Avoid row below the same row without a preference", async () => {
      const forB = await search(b);
      const avoided = forB.find((r) => r.description.includes("breast, meat only"));
      const neutral = forB.find((r) => r.description.includes("thigh, meat only"));
      expect(Number(avoided?.f_eats)).toBeLessThan(Number(neutral?.f_eats));
    });

    it("returns only active revisions of the active version", async () => {
      exec(`update catalog_versions set is_active = false where version_label = 'test-catalog-v1';`);
      expect((await search(a)).length).toBe(0);
      exec(`update catalog_versions set is_active = true where version_label = 'test-catalog-v1';`);
      expect((await search(a)).length).toBeGreaterThan(0);
    });
  });
  ```

- [ ] Run — expect PASS (skipped with no branch):
  ```bash
  pnpm test tests/search/cross-user.test.ts
  ```
  Expected: `Test Files  1 passed`, `Tests  4 passed`.

- [ ] Commit:
  ```bash
  git add tests/search/cross-user.test.ts
  git commit -m "test: prove catalog search never crosses users"
  ```

---

## Task 16 — The relevance gate

**Files**
- Test: `tests/search/relevance.test.ts`

**Interfaces**
- Consumes: `relevanceMetrics`, `resolveLabels`, `LabelledQuery` from `@/lib/search/eval`; `parseQuery`
  from `@/lib/search/query`; `ensureUser`, `userClient`, `HAS_BRANCH` from `../helpers/supabase`;
  `docs/catalog/labelled-queries.jsonl`.
- Produces: nothing. This is Phase 1 acceptance criterion 8, and it only means anything against Lane F's
  real import — so it runs when `CATALOG_ACTIVE=1` is set by hand, never in CI.

### Steps

- [ ] Write the failing test — create `tests/search/relevance.test.ts`:
  ```ts
  import { readFileSync } from "node:fs";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { beforeAll, describe, expect, it } from "vitest";
  import { relevanceMetrics, resolveLabels, type LabelledQuery, type Runs } from "@/lib/search/eval";
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
          ((hits ?? []) as Record<string, never>[]).map(
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

    it("reaches top-1 ≥ 85 % and top-3 ≥ 95 %", () => {
      const m = relevanceMetrics(labels, runs);
      if (m.top1 < 0.85 || m.top3 < 0.95) console.log("misses:", m.misses.map((x) => x.q).join(", "));
      expect(m.top1).toBeGreaterThanOrEqual(0.85);
      expect(m.top3).toBeGreaterThanOrEqual(0.95);
    });
  });
  ```

- [ ] Run — expect SKIP without the flag, and the real gate with it:
  ```bash
  pnpm test tests/search/relevance.test.ts
  ```
  Expected: `Test Files  1 skipped` (no `CATALOG_ACTIVE`).
  ```bash
  CATALOG_ACTIVE=1 pnpm test tests/search/relevance.test.ts
  ```
  Expected once Lane F's import is active and Devin has filled every `sourceId`:
  `Test Files  1 passed`, `Tests  2 passed`.

- [ ] Commit:
  ```bash
  git add tests/search/relevance.test.ts
  git commit -m "test: gate catalog search on the labelled relevance set"
  ```

---

## Lane exit gate

Run in this order from the lane branch. Never run the full suite twice — CI runs it on the PR.

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test lib/search/ lib/server/catalog.test.ts tests/search/
```
Expected: lint clean, no type errors, and every unit and mocked-route test green. Without a branch the
four branch suites report `skipped`, which is the correct CI result.

```bash
git diff main --stat
```
Expected: exactly the 25 files in the File structure table, and nothing else. No change to
`package.json`, `vitest.config.ts`, `docs/architecture.md`, `DESIGN.md`, `lib/server/auth.ts`,
`lib/server/http.ts`, `lib/server/admin.ts`, `lib/server/ratelimit.ts`, or any Lane F migration.

```bash
grep -rn "SUPABASE_SERVICE_ROLE_KEY" lib/search lib/server/catalog.ts app/api/foods scripts/search-eval.ts
```
Expected: no output. The service role reaches this lane only through `adminClient()` inside
`scripts/apply-food-mapping.ts`.

With a Supabase branch (`scripts/db-branch.sh env`, Lane A):

```bash
psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260912090100_catalog_search.sql
pnpm test tests/search/
```
Expected: `Tests  ... passed` across `rpc-security`, `score-parity`, `cross-user`, the two route suites,
and `relevance` skipped until `CATALOG_ACTIVE=1`.

**Phase gate, after Lane F's import is active** (this is what closes acceptance criteria 8 and 9 — it is
not a CI step):

```bash
pnpm exec tsx scripts/search-eval.ts
CATALOG_ACTIVE=1 pnpm test tests/search/relevance.test.ts
git diff --stat lib/search/thresholds.ts
grep -n "0.8, minMargin: 0.15" lib/search/thresholds.ts
```
Expected: top-1 ≥ 85 %, top-3 ≥ 95 % over ≥ 60 resolved labels; `lib/search/thresholds.ts` rewritten with
the calibrated pair; the last grep returns nothing, because the provisional 0.80 / 0.15 pair must no
longer appear in code (acceptance criterion 9).

Then commit the calibrated file:

```bash
git add lib/search/thresholds.ts
git commit -m "chore: commit the calibrated auto-resolve thresholds"
```

## Hand-off to integration

**What this lane depends on and cannot build itself.**

| From | What | Why it blocks |
|---|---|---|
| Lane B (Phase 0) | `requireUser`, `HttpError`, `jsonError`, `enforceRateLimit` + `resetRateLimits`, `adminClient` | Both routes and `scripts/apply-food-mapping.ts` import them. Until they land, Tasks 5, 8, 9 and 12 compile against the contract signatures only. |
| Lane A (Phase 0) | `tests/helpers/supabase.ts` (`HAS_BRANCH`, `ensureUser`, `userClient`, `resetUser`, `createTestUsers`), `scripts/db-branch.sh`, `get_or_create_food_ref` | Tasks 14–16 and Task 12's real run. |
| Lane F | `catalog_versions`, `catalog_foods`, `catalog_food_revisions` (with `search_doc`, `content_hash`, the GIN indexes), `catalog_foods.source`, `catalog_portions`, `catalog_ingredients`, `catalog_nutrients`, `catalog_food_nutrients`, RLS select-only grants, and the immutable `catalog_search_doc(description, brand, category)` helper | The RPC, the detail read and `tests/search/fixtures.ts` all name them. `catalog_search_doc` must be executable by `service_role` for the fixture to build a `search_doc`. |
| Lane F | **Every active revision points at an active `catalog_versions` row.** | The RPC joins `catalog_versions … and v.is_active`. If `catalog_activate_version` ever leaves an active revision on a superseded version, that food silently stops being searchable. |
| Lane F | `docs/catalog/her-foods-mapping.csv` with the header in Task 12 | `scripts/apply-food-mapping.ts` refuses any other header, by design. |
| Devin | A filled `sourceId` on every line of `docs/catalog/labelled-queries.jsonl` | The relevance gate counts only resolved labels. |

**What this lane hands over.**

- **Lane I** consumes `FoodSearchRequest`, `FoodSearchHit`, `FoodSearchResponse`, `FoodDetail` and
  `CatalogSource` by `import type` from `lib/server/catalog.ts`, and the two routes. `catalogVersion` on
  both responses is the in-memory cache key the spec asks for. A `503` with
  `{ error: "catalog_unavailable" }` is the signal to fall back to `lib/food-db.json` and label the
  results "offline results"; a `429` carries `Retry-After: 60`.
- **Lane I** also consumes `shouldAutoResolve` and `AUTO_RESOLVE` from `lib/search/thresholds.ts` if the
  confirm sheet needs them, and `toGtin14` when Phase 3 adds barcode capture.
- **Lane H** consumes nothing from this lane. `log_items` and `log_entries` flow the other way: the more
  H writes, the better the `user_prior` feature gets.
- **Phase 4** consumes `combine`, `featuresFromRow` and `shouldAutoResolve` for AI grounding: the RPC's
  feature columns are what let a proposal be re-scored client-side without a second round trip.
- Nothing in this lane writes `catalog_*`. The import worker stays the only writer (architecture §7.2).

**Integration-branch follow-ups, not this lane's commits.**

1. Add the `/api/foods/[id]` row to the §5 matrix in `docs/architecture.md` — the Phase 1 spec says that
   file gains it, and `docs/architecture.md` is shared.
2. Open question 1 is resolved: contracts §2 was corrected to architecture §4.1's numbers, and this
   plan's `lib/search/features.ts` and `supabase/migrations/20260912090100_catalog_search.sql` already
   carry them — no further integration-branch diff is needed.
3. Add `SEARCH_EVAL_EMAIL` and `SEARCH_EVAL_PASSWORD` to `.env.example` under a
   `[eval only — never Vercel]` comment.

## Open questions

1. **Resolved 2026-09-11: contracts §2 was corrected to architecture §4.1; this plan implements it.**
   The score constants used to disagree, on four points: lexical (`ts_rank(search_doc, tsq, 32)` vs
   `ts_rank_cd`), quality (analytical 1.0 / survey 0.75 / label 0.5 / crowd 0.25 vs 1.0 / 0.8 / 0.6 /
   0.4), the `energy_mismatch` penalty (−0.25 vs −0.2), and the brand fallback (0.6 when
   `similarity ≥ 0.6` else 0, vs the raw `similarity`). The Phase 1 spec's own unit-test line
   ("`energy_mismatch` subtracts 0.25") sided with architecture, and architecture outranks contracts in
   the authority order this file's own header states — that is the ruling. `lib/search/features.ts`
   (`QUALITY`, `ENERGY_MISMATCH_PENALTY`, `brandMatchScore`) and
   `supabase/migrations/20260912090100_catalog_search.sql` (`ts_rank`, the matching `case` expressions,
   the brand threshold) carry architecture's numbers throughout this plan, and
   `lib/search/features.test.ts` (Task 2) and `tests/search/score-parity.test.ts` (Task 14) assert them.
   Task 11's calibration run measures this scorer, the one that ships — settling this before the eval
   run is what keeps `lib/search/thresholds.ts` and the relevance numbers from being invalidated later.

2. **`prep_state` vocabularies do not match — resolved by Lane F, owned there.** Architecture §3.1's
   check constraint allowed `raw, cooked, boiled, roasted, fried, grilled, canned, dried`; contracts
   §3's `PrepState` is `raw, cooked, roasted, grilled, fried, boiled, baked, unknown`. Lane F's Task 1
   now ships the DDL check as contracts' own union (adding `baked`/`unknown`, dropping `canned`/
   `dried`) with no contract change needed, since contracts' union is the narrower, already-frozen
   one — and Task 8's `PREP_STATE_CASE` no longer emits `canned` or `dried`, proved by a test. A
   `prep=baked` query still matches nothing today (the mapper folds "baked" text into `roasted`
   rather than emitting `baked`), which is unchanged from before and still costs recall on baked
   goods, not blocking.

3. **How many `catalog_versions` rows are active at once? Resolved: one per source.** Spec acceptance
   criterion 2 used to say "exactly one row with `is_active = true`", but `catalog_versions.source` is
   a single value and Lane F imports three sources. Lane F's `catalog_versions_one_active_per_source`
   index (its Task 1) is one active row **per source**, so this lane's join is sound as written; had
   it been one globally with each source getting its own row, two thirds of the catalog would vanish
   from search. `docs/specs/phase-1-catalog.md` acceptance criterion 2 is now reworded to say "one
   active version per source, all sharing one `version_label`", matching Lane F's index.

4. **The mapping CSV header is a contract this lane invented.** Task 12 fixes it as
   `user_food_id,food_name,proposed_catalog_food_id,proposed_description,proposed_source,decision,corrected_catalog_food_id,note`
   and the script refuses anything else. `scripts/map-her-foods.py` (Lane F) must emit exactly that.
   Recommendation: add the header to contracts §2 in the same commit that corrects it for question 1.

5. **`classifyQuery` misses a single-token brand.** "RXBAR chocolate" classifies generic because only one
   token is capitalised. `brand:RXBAR` works, and the branded/generic split only chooses which calibrated
   threshold pair applies, so the cost is bounded. Recommendation: leave it, and revisit with real query
   logs at Phase 3 when branded rows actually exist.

6. **Migration contents differ from the spec's table.** The Phase 1 spec puts `catalog_atwater_kcal`,
   `catalog_activate_version` and the GIN indexes inside `20260912090100_catalog_search.sql`; contracts §1
   assigns all three to Lane F's `…090050_catalog_activate.sql` and `…090000_catalog_tables.sql`. This
   lane follows the contract and ships only `catalog_search` in `…090100`. No action needed unless the
   spec is re-read as authority.

7. **`Retry-After` is the window length, not the remaining seconds.** `enforceRateLimit` reports the
   remaining seconds only inside its message string. Sending a flat `60` is always safe (never early) and
   needs no change to a file this lane does not own. Recommendation: when Lane B's rate limiter moves from
   the in-instance `Map` to a table, have it carry `retryAfter` on the `HttpError` and read it here.

8. **`FoodDetail.score` is `0`.** The type is `FoodSearchHit & {…}` and a detail read has no query to
   score. Lane I must not render it. Recommendation: at Phase 3, split `FoodDetail` off `FoodSearchHit`
   so the field disappears rather than lying.

9. **The eval's two env names are not in contracts §6.** `SEARCH_EVAL_EMAIL` and `SEARCH_EVAL_PASSWORD`
   are script-only, never on Vercel, and exist because a `security invoker` RPC needs a signed-in caller
   to score the personalised features at all. They belong in `.env.example` on the integration branch.
