# Phase 1 — Catalog

Spec of record for Phase 1. Authority is `docs/architecture.md` v2.1, referenced
by section number and never restated. Numbers stay in `../analysis/targets.md`.

**Depends on Phase 0.** Search runs on the browser path (§2.1), so Supabase Auth,
the request-local server client, `user_foods`, `food_refs`, `user_food_prefs` and
`get_or_create_food_ref` must exist first.

## Goal

Put a real food catalog behind the app: import USDA Foundation, SR Legacy and
FNDDS into the `catalog_*` tables of §3.1, and serve the §4.1 ranked search over
them. Map the 53 foods she already has to catalog rows, so Phase 2 can log grams
against a source of truth instead of a hand-authored per-unit number.

## Scope

**In.** Dry-run sizing on local Postgres. The import worker and its staging
schema. The `catalog_*` tables, indexes, grants and read policies. The energy
(Atwater) computation and `energy_mismatch` flag. The search RPC,
`GET /api/foods/search` and a food detail read with source attribution. The
labelled query set, the relevance measurement and the calibrated thresholds. Her
seed and preset foods mapped to catalog rows, reviewed by Devin.

**Out.** Branded and Open Food Facts cache-on-miss rows, barcode lookup and
`/api/foods/barcode` — Phase 3. Grams, snapshots and micronutrient display —
Phase 2. AI proposal and grounding — Phase 4. An MCP `search_foods` tool —
Phase 7. `catalog_barcodes` and `catalog_dri` are created empty and filled later.

## User stories

- **Sasha.** She types "chicken thigh" into the log sheet and sees real foods,
  the ones she eats ranked first, not a 460-row bundled list. She opens a result
  and sees where the number came from.
- **Sasha, offline.** No signal. Search still answers from the bundled
  `lib/food-db.json`, marked "offline results", and nothing errors.
- **Devin.** He opens `docs/catalog/her-foods-mapping.csv`, checks each of her 53
  foods against the row it matched, and corrects the wrong ones in one file. He
  reruns the eval and reads the top-1 and top-3 numbers.
- **Agent via MCP.** No new tool this phase. `list_foods` keeps working; the
  mapping adds `catalog_food_id` to her rows, so an agent can resolve a food to a
  USDA id.

## Data changes

§3.1 holds the DDL for all nine `catalog_*` tables. Ship it verbatim. **Migration filenames are
timestamp-prefixed** (`YYYYMMDDHHMMSS_name.sql`), matching Supabase's own convention and the scheme
Phase 0 already uses (`20260911000100_catalog_shell.sql` … `20260911000800_drop_legacy.sql`) — not the
`0001`–`0009` numeric scheme this file previously assumed for Phase 0, which does not match Phase 0's
actual filenames. Phase 1's three migrations below are dated after Phase 0's and before Phase 2's
(`20260918090000_…`), so Supabase's filename-order application matches the dependency order.

| Migration | Contents |
|---|---|
| `supabase/migrations/20260912090000_catalog_tables.sql` | Extensions `pg_trgm`, `unaccent`; the §3.1 DDL; schema `catalog_staging` |
| `supabase/migrations/20260912090100_catalog_search.sql` | `catalog_atwater_kcal`, `catalog_activate_version`, `catalog_search`, the GIN indexes |
| `supabase/migrations/20260912090200_catalog_grants.sql` | RLS, read policies and grants below; a `.down.sql` beside it is tested and held unapplied |

**`catalog_*` is shared and read-only to users.** RLS is on so the publishable key
cannot write; the service role bypasses it and is the only writer (§2.2 rule 4).

```sql
-- for each of catalog_foods, catalog_food_revisions, catalog_food_nutrients,
-- catalog_portions, catalog_ingredients, catalog_nutrients, catalog_versions:
alter table catalog_foods enable row level security;
create policy catalog_foods_read on catalog_foods for select to authenticated using (true);
grant select on catalog_foods to authenticated;
-- No insert, update or delete policy exists on any of the seven, so a
-- JWT-scoped client can never write the catalog.
```

**`search_doc` is written by the worker, not generated.** `unaccent` is not
immutable, so a generated column or an expression index over it is rejected:

```sql
create function catalog_search_doc(p_description text, p_brand text, p_category text)
returns tsvector language sql immutable as $$
  select setweight(to_tsvector('english', unaccent(coalesce(p_description,''))), 'A')
      || setweight(to_tsvector('english', unaccent(coalesce(p_brand,''))), 'B')
      || setweight(to_tsvector('english', unaccent(coalesce(p_category,''))), 'C'); $$;
```

`unaccent` is schema-qualified in the migration, and the immutable declaration is
deliberate: the dictionary is fixed for the life of the database, and a reimport
rewrites every `search_doc` anyway.

**Energy.** One implementation, in SQL, per §3.1 —
`catalog_atwater_kcal(p_revision_id bigint) returns table (kcal numeric,
complete boolean)`. The worker calls it during staging validation; nothing
recomputes it in TypeScript. `complete` is false when the source reports
alcohol, sugar alcohols or organic acids it cannot value, which adds
`atwater_incomplete` to `quality_flags` and drops the row from the mismatch
check. A gap above 10 % against `energy_kcal` adds `energy_mismatch`.

**Activation is one transaction.** `catalog_activate_version(p_version_id bigint)`
inserts the `catalog_versions` row, flips `is_active` per food so the partial
unique index `catalog_food_revisions_one_active` holds at commit, and sets
`valid_to` on the revision it replaces. Food identities are never rewritten, so
`food_refs` and `user_foods.catalog_food_id` survive every import (§3.1).

**Search RPC.** `catalog_search(p_query text, p_brand text, p_prep text, p_limit
int)` carries the §4.1 SQL unchanged and is **`security invoker`**, so
`auth.uid()` is the caller and RLS applies to the `user_food_prefs`,
`log_entries` and `log_items` joins. A `security definer` variant for the
privileged boundary waits for Phase 7.

**Her foods.** No new column: `user_foods.catalog_food_id` already exists (§3.2).
The mapping writes it and calls `get_or_create_food_ref('catalog', id)`, so
`user_food_prefs` points at the shared registry row. No `user_foods` row is
deleted, and her authored `per_100g` stays the fallback for a wrong mapping.

## API changes

New file `app/api/foods/search/route.ts`. A Supabase JWT, verified with
`getClaims()` on a request-local client (§2.1); 8 KB body, 120/min/user (§5).

```ts
// GET /api/foods/search?q=chicken+thigh&brand=&prep=roasted&limit=25
export type FoodSearchRequest = {
  q: string; brand?: string; prep?: PrepState; limit?: number;  // q 1..120 chars, limit 1..25
};
export type FoodSearchHit = {
  catalogFoodId: number; revisionId: number; description: string; brand: string | null;
  source: CatalogSource;        // 'fdc_foundation'|'fdc_sr_legacy'|'fdc_fndds'|'fdc_branded'|'off'
  qualityClass: QualityClass;   // 'analytical'|'survey'|'label'|'crowd'
  qualityFlags: string[]; prepState: PrepState | null;
  score: number;                // [0,1], 4 decimals
  prefStatus: 'eats' | 'avoid' | null;
};
export type FoodSearchResponse = {
  hits: FoodSearchHit[]; queryClass: 'branded' | 'generic';
  autoResolve: { revisionId: number; score: number; margin: number } | null;
  catalogVersion: string;       // active version_label, for cache keys
};
```

New file `app/api/foods/[id]/route.ts`, `GET`, same auth and limits, `id` a
`catalogFoodId`. An `off` row's `attribution` reads `"Data from Open Food Facts
(ODbL)"` (§3.1); an `fdc_*` row names the USDA source and version label.

```ts
export type FoodDetail = FoodSearchHit & {
  category: string | null; catalogVersion: string; attribution: string;
  per100g: Record<string, { amount: number | null; unit: string }>;  // null = not measured
  portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
  ingredients: { seq: number; name: string; allergenTags: string[] }[];   // seq order
};
```

**Error cases**, both routes: `401` no or invalid session; `400` `q` empty, over
120 chars, `limit` out of range, or `prep` outside the enum; `404` unknown or
inactive `catalogFoodId`; `429` over the rate limit, with `Retry-After`; `503`
when no `catalog_versions` row is active, so the client falls back to the bundled
database instead of showing an empty list; `500` never carries the SQL error text.
§5 lists `/api/foods/search` but not `/api/foods/[id]` — architecture.md gains
that row in the same class.

## Client changes

- `lib/server/catalog.ts` — server-only. Wraps the RPC and the detail query; the
  only module the two routes talk to. No service-role key.
- `lib/catalog-client.ts` — browser fetch helpers, one `AbortController` per
  keystroke, 200 ms debounce.
- `components/CatalogSearch.tsx` — the search surface. Hits carry an Eats or
  Avoid pill, an amber pill on `energy_mismatch`, and the source label.
- `components/FoodDetailSheet.tsx` — per-100 g values, portions, source line and
  attribution. Opens from a hit. Read-only in Phase 1.
- `components/LogFoodSheet.tsx` — edited, not replaced. Online and with the flag
  on, results come from `CatalogSearch`; otherwise today's `searchFoods()` path
  runs unchanged. The write path does not change this phase: a chosen catalog
  food still logs into `StoredDay.extras`, using the detail response's portions.

**Offline.** Catalog search is server-side Postgres, so it cannot run offline.
`lib/food-db.ts` and `lib/food-db.json` stay in the bundle as the offline tier
and are not deleted. On a failed fetch or a `503` the sheet falls back silently
and shows one "offline results" line. The last 20 successful queries cache in
memory, keyed by `catalogVersion`; nothing new is written to localStorage. The
flag is `NEXT_PUBLIC_CATALOG_SEARCH`; unset gives the Phase 0 behaviour, so the
client half rolls back without redeploying the server half.

## Engines and logic

Pure, no I/O, unit tested.
```ts
// lib/search/query.ts
export type ParsedQuery = { raw: string; brand: string | null; prep: PrepState | null };
export function parseQuery(input: string): ParsedQuery;
export function classifyQuery(q: ParsedQuery): 'branded' | 'generic';
export function normalizeBrand(s: string): string;

// lib/search/features.ts — mirrors the §4.1 SQL, one function per feature row
export type Features = { lexical: number; trigram: number; brandMatch: number;
  prepStateMatch: number; userPrior: number; qualityClass: number; eatsStatus: number };
export const WEIGHTS: Readonly<Features>;                     // sums to 1.00
export function combine(f: Features): number;                 // bounded [0,1]
export function userPriorScore(logs90d: number): number;      // ln(1+n)/ln(21), capped
export function qualityClassScore(cls: QualityClass, flags: string[]): number;
export function prepStateMatchScore(q: PrepState | null, row: PrepState | null): number;
export function brandMatchScore(q: string | null, row: string | null, sim: number): number;
export function eatsStatusScore(status: 'eats' | 'avoid' | null): number;

// lib/search/thresholds.ts — calibrated values, committed at the end of this phase
export type AutoResolveThreshold = { minScore: number; minMargin: number };
export const AUTO_RESOLVE: Record<'branded' | 'generic', AutoResolveThreshold>;
export function shouldAutoResolve(hits: { score: number }[], cls: 'branded' | 'generic'): boolean;

// lib/search/gtin.ts — the import normalizes GTINs now; lookup arrives in Phase 3
export function toGtin14(raw: string): string | null;     // null on a bad check digit

// lib/search/eval.ts
export type LabelledQuery = { q: string; source: CatalogSource; sourceId: string; note?: string };
type Runs = FoodSearchHit[][];                            // one result list per labelled query
export function relevanceMetrics(l: LabelledQuery[], r: Runs):
  { n: number; top1: number; top3: number; misses: LabelledQuery[] };
export function calibrate(l: LabelledQuery[], r: Runs):
  Record<'branded' | 'generic', AutoResolveThreshold>;
```

Scripts, in the style of the existing `scripts/build-food-db.py`:

| Script | What it does |
|---|---|
| `scripts/catalog-dry-run.sh` | Brings up local Postgres 17 on Colima, applies `20260912090000`–`20260912090200`, imports all three sources, runs the size report |
| `scripts/catalog-size-report.sql` | `pg_total_relation_size` per table and index, plus the headroom percentage against the Supabase Pro disk |
| `scripts/import-fdc.py` | The worker of §7.2: download with checksum → `catalog_staging.*` → validate → `catalog_activate_version` in one transaction. `--rollback-to <version_label>` reactivates a previous version |
| `scripts/map-her-foods.py` | Proposes a catalog row per seed and preset food, writes `docs/catalog/her-foods-mapping.csv` for review |
| `scripts/apply-food-mapping.ts` | Applies the reviewed CSV: sets `user_foods.catalog_food_id`, calls `get_or_create_food_ref` |
| `scripts/search-eval.ts` | Runs `docs/catalog/labelled-queries.jsonl`, prints top-1 and top-3, writes calibrated thresholds |

The worker needs a direct Postgres URL and the service-role key: add
`CATALOG_IMPORT_DB_URL` to `.env.example`, marked `[worker only — never Vercel]`.

## Security

Rows this phase adds to the §5 matrix:

| Route | Identity | Body limit | Rate limit | Idempotency | Notes |
|---|---|---|---|---|---|
| `/api/foods/search` | Supabase JWT (§2.1) | 8 KB | 120/min/user | — | `security invoker` RPC; `auth.uid()` from the session, never the query string |
| `/api/foods/[id]` | Supabase JWT | 8 KB | 120/min/user | — | new row; returns the attribution string |
| import worker | service role, Mac or GitHub Actions, **not** Vercel | — | — | `catalog_versions.version_label` | §7; the only writer to the `catalog_*` food tables (`scripts/load-synonyms.ts` is the dedicated writer of `catalog_synonyms`) |

Rules this phase must hold. `q` is bound as a parameter and reaches
`websearch_to_tsquery` through the RPC — never string-concatenated. The catalog
carries read policies only, so a leaked publishable key cannot poison food data.
The service-role key stays in `lib/server/admin.ts` and the worker (§2.2 rule 4);
neither route imports it. Search reads her prefs and log counts, so a cross-user
denial test covers both routes, and a test asserts `security invoker` on the RPC.

## Test plan

**Unit files to add:**

- `lib/search/query.test.ts` — brand and prep extraction; a query with no brand
  classifies `generic`; punctuation and accents normalize.
- `lib/search/features.test.ts` — every feature maps into `[0,1]`; `WEIGHTS` sums
  to exactly 1.00; `combine` is bounded; `userPriorScore(20) === 1`;
  `energy_mismatch` subtracts 0.25 and floors at 0.
- `lib/search/thresholds.test.ts` — `shouldAutoResolve` needs the score and the
  margin; a single hit never auto-resolves.
- `lib/search/gtin.test.ts` — UPC-A and EAN-13 pad to GTIN-14; bad check digit → null.
- `lib/search/eval.test.ts` — `relevanceMetrics` on a fixture with known misses.
- `lib/catalog-client.test.ts` — response parsing; a `503` returns the offline
  signal rather than throwing.

**Integration cases**, against a local Postgres seeded by the dry run.

1. `catalog_search` scores a fixed row within 1e-4 of `combine()` — the SQL and
   TypeScript mirrors do not drift.
2. Two revisions of one food: only the active one returns; activating the new one
   keeps `catalog_food_id` stable and `food_refs` intact.
3. A second import of the same version is a no-op; a failed import leaves the old
   version active.
4. A food on Avoid ranks below the same-score food on Eats.
5. Cross-user denial: user B's query never reflects user A's prefs or log counts.
6. An authenticated publishable-key client may select from `catalog_foods` and may
   not insert, update or delete; an anon client reads nothing.
7. `/api/foods/search` returns 401 with no session, 400 on `q=""`, 503 with no
   active version.
8. Relevance run: `scripts/search-eval.ts` over `docs/catalog/labelled-queries.jsonl`.

**Manual gate, Devin, on her phone.** Signed in as Sasha, search ten of her foods
— chicken breast, sirloin, ahi tuna, white rice, sweet potato, butternut, banana,
avocado, almond butter, olive oil. Each must be the top hit. Open three and check
per-100 g protein, carbs and fat against `fdc.nal.usda.gov`. Turn airplane mode on
and search again: results appear, marked offline. Then read the mapping CSV end to
end and sign off on all 53 rows.

## Acceptance criteria

1. The dry run reports size and headroom per table and index into
   `docs/catalog/sizing.md`. Headroom on the Supabase Pro disk is ≥ 40 % with all
   three sources loaded; if not, FNDDS moves to on-demand, recorded in that file.
2. `scripts/import-fdc.py` loads all three sources into Supabase and leaves
   exactly one active version per source, all sharing one `version_label`.
3. Exactly one revision per `catalog_food_id` is active, proved by the partial
   unique index. A reimport of the same `version_label` changes no row, exits 0.
4. `energy_kcal_calc` exists on every revision whose source reports the macros,
   `atwater_incomplete` rows are excluded from the mismatch check, and the worker
   reports the `energy_mismatch` rate into `docs/catalog/sizing.md`.
5. `GET /api/foods/search` returns ranked hits for an authenticated caller, and
   401, 400, 429 and 503 in the cases listed above.
6. Every `catalog_*` table has RLS on with a select-only policy, and a test proves
   an authenticated non-service client cannot write.
7. `catalog_search` is `security invoker`, proved by a test reading
   `pg_proc.prosecdef`.
8. The labelled set holds ≥ 60 of her real queries, and the eval reports
   **top-1 ≥ 82 %** (superseded by R1, `docs/decisions/2026-09-12-session-rulings.md`) and
   **top-3 ≥ 95 %**.
9. `scripts/search-eval.ts` computes the branded and generic `AUTO_RESOLVE`
   values and they are committed in `lib/search/thresholds.ts`; the provisional
   0.80 / 0.15 pair no longer appears in code.
10. All 53 seed and preset foods carry a `catalog_food_id` and a `food_refs` row,
    or a recorded reason for staying unmapped; Devin has signed the CSV.
11. With `NEXT_PUBLIC_CATALOG_SEARCH` unset, the app behaves exactly as it did at
    the end of Phase 0 — `lib/food-db.test.ts` stays green and untouched.
12. `pnpm test`, `pnpm lint` and `pnpm build` pass; the offline fallback has a test.

## Rollout and rollback

**Order.** Dry run → migrations `20260912090000`–`20260912090200` on Supabase → import from the Mac →
mapping CSV → Devin's review → `apply-food-mapping.ts` → deploy the routes with
the flag off → eval and calibration → commit thresholds → flag on → manual gate.
**Rollback, per layer:**

- *Client.* Unset `NEXT_PUBLIC_CATALOG_SEARCH`. The bundled search returns at
  once, with no deploy and no data change.
- *Routes.* Revert the deploy on `main`. The catalog tables stay; nothing else
  reads them.
- *A bad import.* `scripts/import-fdc.py --rollback-to <version_label>`
  reactivates the previous revisions in one transaction. That version is kept for
  exactly this (§7.2); only older ones are dropped.
- *A bad mapping.* Clear `catalog_food_id` on the affected rows and rerun the
  idempotent script. `user_foods.per_100g` was never overwritten, so her numbers
  hold either way.
- *Schema.* `20260912090200_catalog_grants.down.sql` plus a tested drop of the Phase 1
  tables. No user table is altered, so a rollback loses catalog data and nothing
  else.

## Open questions

1. **Phase 0 ordering.** If Phase 0 slips, may Phase 1 land the worker and schema
   alone and hold the routes back? Recommendation: yes — the import needs no auth
   and takes the longest.
2. **FNDDS.** Sizing decides bulk or on demand; the answer lands in
   `docs/catalog/sizing.md`, not here.
3. **Labelled set.** Her 53 foods plus log queries clears 60 only if the logs hold
   enough distinct foods; otherwise Devin writes the rest. Who labels the correct
   row? Recommendation: the script proposes, Devin corrects.
4. **Where the eval runs.** CI has no catalog database. Recommendation: run it on
   the Mac against Supabase and commit the report; CI keeps the unit tests only.
5. **Category vocabulary.** The three sources name categories differently, and
   category reaches search only through `search_doc` weight C. Recommendation:
   keep the source value and defer normalization.
6. **Migration naming — resolved 2026-09-10.** Every phase spec now uses Phase 0's timestamp
   convention (`supabase/migrations/YYYYMMDDHHMMSS_<slug>.sql`); Phase 5 and Phase 7 were renamed.
