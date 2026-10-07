# Phase 3 — Fast capture

Spec for the Phase 3 row of `docs/architecture.md` §8. The architecture file is the authority; this
file only adds implementation detail. Depends on Phase 0 (auth, privileged boundary, sync ops with
compare-and-swap), Phase 1 (`catalog_*`, search) and Phase 2 (grams, snapshots, Today totals).

Note on sources: the PRD §9 lists a barcode database under "deliberately excluded". Architecture v2.1
§1 supersedes that line and schedules barcode, favorites and water into this phase. `targets.md` is
untouched by Phase 3 — no number in this spec changes a target.

## Goal

Make logging a packaged food, a repeated food, a saved recipe or a cup of water fast enough that she
does not avoid it. Phase 3 ships a barcode path that resolves a GTIN against the catalog and caches
misses from Open Food Facts and FDC Branded, plus versioned recipes, favorites and water.

## Scope

**In.** `zxing-wasm` barcode scan on the phone. `POST /api/foods/barcode` with cache-on-miss against
OFF and FDC Branded. Negative caching and a 90-day refresh (§7.3). Versioned recipes (`recipes`,
`recipe_revisions`, `recipe_items`) with nutrients frozen per revision at save. Favorites for foods,
recipes and meals. Water as a first-class entity with a daily goal. Sync ops, merge rules and export
kinds for every entity above.

**Out.** AI capture of any kind — text, voice, label photo, plate photo (Phase 4). Any camera path
that sends an image to a model. Health data (Phase 5). The estimator and percent targets (Phase 6).
Coach (Phase 7). Bulk FDC Branded import: Branded stays cache-on-miss per §3.1. Recipe sharing
between users, recipe scaling by target macros, and barcode writing back to OFF.

## User stories

- **Sasha.** She picks up a packaged pouch, taps **+ → Scan**, points the camera at the barcode, and
  the confirm sheet opens with the product, its ingredients and an allergen badge. She taps the
  portion and logs it. Second time, it resolves with no network. She stars it, so next time it is one
  tap from the Favorites strip. She saves her usual rice-and-chicken tray as a recipe with 4 servings
  and logs one serving a day. She taps the water card each time she drinks a cup.
- **Devin.** He scans three packaged foods on her phone and times each one. He opens a scanned OFF
  row and checks the ODbL notice renders. He edits a recipe and confirms the earlier revision's
  nutrients did not change under him, and that logs made from it still read the old numbers.
- **An agent over MCP.** Reads her favorites and recipes through the existing read tools, and logs a
  serving of a saved recipe with `entry_id` idempotency. Every call is bound to one `user_id` by the
  privileged boundary (§2.2); no MCP tool may create a catalog row.

## Data changes

Phase 0 already created `water_log`, `log_entries`, `log_items`, `food_refs`, `user_foods` and
`change_log`; Phase 1 created `catalog_*`. Phase 3 adds the tables below.

`supabase/migrations/20260919090000_phase3_recipes_favorites.sql` — the §3.2 DDL for `recipes`,
`recipe_revisions`, `recipe_items`, `favorites_foods`, `favorites_recipes`, `favorites_meals` and
`favorites_meal_items`, verbatim from the architecture, plus the policies. Child tables carry no
`user_id`, so they inherit the tenant through their parent:

```sql
alter table recipes enable row level security;
create policy recipes_rw on recipes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter table recipe_revisions enable row level security;
create policy recipe_revisions_rw on recipe_revisions for all to authenticated
  using (exists (select 1 from recipes r
                  where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())))
  with check (exists (select 1 from recipes r
                  where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())));
```

`recipe_items` takes the same parent-exists pair, joined through `recipe_revisions` to `recipes`.
`favorites_foods`, `favorites_recipes` and `favorites_meals` take the plain `user_id` policy pair;
`favorites_meal_items` takes the parent-exists pair against `favorites_meals`. Every favorites table
gains `rev integer not null default 1` and `updated_at timestamptz not null default now()` so it
syncs like any other entity, and `favorites_meals` gains `deleted_at timestamptz`.

`supabase/migrations/20260919090100_phase3_barcode_cache.sql` — the lookup ledger that keeps a miss
from becoming a repeated outbound fetch. It holds no user data, so it has no RLS and no grants to
`authenticated`:

```sql
create table catalog_barcode_lookups (
  gtin14 char(14) primary key check (gtin14 ~ '^[0-9]{14}$'),
  status text not null check (status in ('hit','miss','error')),
  source text check (source in ('off','fdc_branded')),
  http_status integer, attempts integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_fetched_at timestamptz not null default now());
create index catalog_barcode_lookups_stale on catalog_barcode_lookups (last_fetched_at);
grant select on catalog_barcode_lookups to authenticated;
```

Cached provider rows are ordinary catalog rows: one `catalog_versions` row per source per fetch date
(`version_label` = `off-2026-09-15`), a `catalog_foods` identity, one active `catalog_food_revisions`
row with `quality_class = 'crowd'` for OFF and `'label'` for FDC Branded, plus its nutrients,
portions, ingredients and a `catalog_barcodes` row. §3.1's revision rules apply unchanged: an import
or a refresh activates a new revision and never rewrites an identity.

**Reconciled 2026-09-11 (resolves open question 3 below):** the `user_prefs` table this section
originally proposed is superseded by `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §3, which
folds the goal into a single `water_goal_cups` column on the existing `user_settings` table instead —
one integer does not earn a table, a policy pair, an `entity_key` shape and a merge rule of its own.
No lane creates `user_prefs`; the table body below is kept for context only and is not built.

`supabase/migrations/20260919090200_phase3_water_goal.sql` — the daily goal. `water_log` itself is
untouched:

```sql
create table user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  water_goal_cups integer not null default 8 check (water_goal_cups between 1 and 30),
  rev integer not null default 1, updated_at timestamptz not null default now());
alter table user_prefs enable row level security;
create policy user_prefs_rw on user_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

Rollback: each migration file has a matching `*_down.sql` that drops only what it created. No Phase 3
migration alters a Phase 0–2 table, so a down-migration cannot lose a log.

## API changes

One new route. Every other Phase 3 mutation travels on the Phase 0 outbox, `POST /api/sync/ops`.

**`POST /api/foods/barcode`** — Supabase JWT (§2.1), 8 KB body, 120/min/user, and a separate
20/min/user budget for outbound provider fetches. `app/api/foods/barcode/route.ts`.

```ts
type BarcodeRequest = { gtin: string; hint?: { brand?: string; name?: string } };

type BarcodeMatch = {
  foodRefId: string; catalogFoodId: number; revisionId: number;
  description: string; brand: string | null;
  source: 'fdc_foundation' | 'fdc_sr_legacy' | 'fdc_fndds' | 'fdc_branded' | 'off';
  qualityClass: 'analytical' | 'survey' | 'label' | 'crowd';
  per100g: Record<string, number | null>;          // null = not measured, 0 = measured zero
  portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
  ingredientsText: string | null; allergenTags: string[];
  attribution: string | null;                       // ODbL notice when source === 'off'
  policy: { verdict: 'allowed' | 'blocked' | 'unverified'; reason?: string };  // §4.4
};

type BarcodeResponse =
  | { status: 'resolved';  gtin14: string; cached: boolean; match: BarcodeMatch }
  | { status: 'ambiguous'; gtin14: string; cached: boolean; matches: BarcodeMatch[] }  // ≤ 3, §4.1 order
  | { status: 'not_found'; gtin14: string; searchHint: { brand?: string; name?: string } };

type BarcodeError = { error: 'invalid_gtin' | 'unauthorized' | 'rate_limited'
  | 'upstream_unavailable'; retryAfterMs?: number };
```

Resolution order: normalise to GTIN-14 and verify the check digit → `catalog_barcodes` → on a hit,
return (`cached: true`) → on a miss, read `catalog_barcode_lookups`; a `miss` row younger than 7 days
returns `not_found` without touching the network → otherwise fetch OFF, then FDC Branded, write the
catalog rows and the lookup row, and return. `status: 'ambiguous'` follows §4.1: several
`catalog_barcodes` rows for one GTIN rank by `quality_class` then `published_at`. A hit older than
90 days is served immediately and refreshed on the next request (§7.3) — never on the hot path.

Errors: `400 invalid_gtin` when the check digit fails or the symbology is not a GTIN; `401` with no
valid session; `429 rate_limited` with `retryAfterMs`; `503 upstream_unavailable` only when both
providers fail *and* nothing is cached — a provider failure after a cache hit is invisible to her.
`status: 'not_found'` is a 200, because "we do not know this barcode" is an answer, not an error.

**Sync ops.** Phase 3 registers new entities on the existing `POST /api/sync/ops` dispatcher; the
envelope, `base_rev` compare-and-swap, conflict payload and `change_log` cursor are all §3.7's and do
not change. New handlers under `lib/server/ops/`: `recipes.ts`, `favorites.ts`, `water.ts`,
`user-prefs.ts`.

```ts
type RecipeSavePayload = {
  name: string; servings: number; yieldGrams?: number;
  items: { seq: number; foodRefId: string; qty: number; unit: string;
           grams: number; state: 'raw' | 'cooked' }[];
};
type RecipeSaveResult = { entity: 'recipes'; entityId: string; rev: number;
  revisionId: string; nutrientsPerServing: Record<string, number | null>; coverage: number };
```

A recipe save always writes a **new** `recipe_revisions` row; the server computes
`nutrients_per_serving` from `compute_item_snapshot` (§3.3) and that value wins over the client's.
A conflict on `recipes` creates a new `rev` on top of `current_rev` with no field merge (§3.7). Water
ops carry `{ local_date, cups }` and merge by the larger value. Favorites ops carry membership plus
`sort`; membership merges by set union, `sort` by the newer `client_ts`.

**Export.** `/api/export` (§4.6) gains `kind=recipes|favorites|water`. OFF-derived rows carry the
ODbL notice; CSV cells starting `= + - @` are prefixed with `'`.

## Client changes

- `components/BarcodeScanSheet.tsx` — full-bleed camera, torch toggle, a cancel target ≥ 44 px.
  `zxing-wasm` runs in a worker (`lib/barcode/worker.ts`); the `.wasm` file is served from
  `public/zxing/` by `scripts/copy-zxing-wasm.mjs` on postinstall, never from a CDN, so the scanner
  works offline and needs no third-party origin in the CSP.
- `components/ScanConfirmSheet.tsx` — product, brand, ingredients, allergen badge from §4.4, portion
  picker, quantity stepper, a star to favorite, one **Log it** button. `status: 'ambiguous'` shows the
  three candidates; `status: 'not_found'` offers search by the brand and name she can read off the
  package, and (Phase 4) a label photo.
- `components/FavoritesStrip.tsx` — a horizontal row at the top of the Foods tab and inside the log
  sheet. Foods, recipes and saved meals in one list, ordered by `sort`.
- `app/recipes/page.tsx` + `components/RecipeSheet.tsx` + `components/RecipeItemRow.tsx` — list,
  create, edit. Editing shows "saving creates version N+1"; earlier revisions stay readable, and any
  log made from an earlier revision keeps its own snapshot.
- `components/WaterCard.tsx` — cups against the goal on Today, with + and − steppers. The existing
  "Log water — 1 cup" item in `components/QuickActions.tsx` stays and now writes the same entity.
- **Offline.** Every resolved barcode is written to an IndexedDB `catalog_cache` store (LRU, 500
  rows) keyed by GTIN-14, so a repeat scan resolves with no network. An offline miss writes a
  `pending_scans` row that retries on reconnect and tells her so, rather than failing silently. Water,
  favorites and recipe saves write locally first and enqueue an op; recipe nutrients render from the
  client's cached catalog rows until the server value returns (§3.3).

## Engines and logic

Pure functions, unit-tested, no I/O:

```ts
// lib/barcode/gtin.ts
export function gtinCheckDigit(body: string): number;
export function normalizeGtin(raw: string): string | null;   // EAN-8/UPC-A/EAN-13/GTIN-14 → 14 digits
export function isGtin(raw: string): boolean;

// lib/barcode/quorum.ts
export type Reading = { text: string; format: string; at: number };
export function acceptReading(history: Reading[], next: Reading, quorum?: number): string | null;

// lib/catalog/off-map.ts   and   lib/catalog/fdc-map.ts
export type RevisionDraft = { description: string; brand: string | null; qualityClass: string;
  per100g: Record<string, number | null>; portions: { description: string; gramWeight: number }[];
  ingredients: { seq: number; name: string; allergenTags: string[] }[]; qualityFlags: string[] };
export function offToRevision(p: OffProduct, fetchedAt: string): RevisionDraft | { reject: string };
export function fdcBrandedToRevision(f: FdcBrandedFood, fetchedAt: string): RevisionDraft | { reject: string };

// lib/recipes/nutrients.ts
export function recipeInputGrams(items: RecipeItemInput[]): number;
export function servingGrams(totalGrams: number, servings: number, yieldGrams?: number): number;
export function computeRecipeNutrients(items: RecipeItemInput[], per100g: Per100gByRef,
  servings: number, yieldGrams?: number): { perServing: Record<string, number | null>; coverage: number };

// lib/water.ts
export const CUP_ML = 240;
export function mergeCups(mine: number, theirs: number): number;          // max, §3.7
export function waterProgress(cups: number, goal: number): { pct: number; met: boolean };

// lib/favorites.ts
export function nextSort(existing: { sort: number }[]): number;
export function mergeFavorites<T extends { key: string; sort: number; clientTs: string }>(
  mine: T[], theirs: T[]): T[];                                            // union, newer sort wins
```

`offToRevision` rejects a product with no energy and no macros, maps OFF `nutriments` to
`catalog_nutrients.code`, carries §3.1's Atwater treatment and `energy_mismatch` flag, and derives
`allergen_tags` from the OFF allergens field **and** an ingredient scan for gluten, dairy and apple —
the apple trap in `targets.md` §5 is the reason a pouch scan must show its ingredient list.
`computeRecipeNutrients` treats `null` as not measured (never as zero) and reports coverage the way
`daily_totals` does, so a recipe with one unmeasured item never reads as complete.

## Security

Rows this phase activates in the §5 matrix, and what it adds to them:

| Route | Identity | Body | Rate limit | Notes |
|---|---|---|---|---|
| `/api/foods/barcode` | Supabase JWT (§2.1) | 8 KB | 120/min/user; 20/min/user outbound | GTIN validated before any I/O; `user_id` is `auth.uid()`, never from the body |
| `/api/sync/ops` (new entities) | Supabase JWT | 1 MB | 60/min/user | RLS on every new table; child tables scoped through their parent |
| `/api/export?kind=recipes\|favorites\|water` | Supabase JWT | 16 KB | 60/day, 10/hour | ODbL notice on OFF-derived rows; CSV formula escaping |

- **Egress is an allowlist.** `lib/catalog/off.ts` and `lib/catalog/fdc.ts` may reach only
  `world.openfoodfacts.org` and `api.nal.usda.gov`. Redirects off those hosts are refused, timeout is
  5 s, and no image or media URL from a provider payload is ever fetched. The GTIN is the only part
  of the request derived from user input, and it is 14 digits by the time it is used.
- **OFF etiquette** (§7.3): cache first, one read at a time per process, an identifying `User-Agent`
  naming the app and a contact address.
- **Catalog writes are server-built.** `lib/server/catalog-writer.ts` is the only module that writes
  `catalog_*` from a request path. It imports `lib/server/admin.ts` (§2.2 rule 4), accepts only a
  `RevisionDraft` produced by the mappers from a provider response, and never a field from the request
  body. `authenticated` holds `select` on `catalog_*` and no write grant, so a compromised session
  cannot poison the catalog. A review-blocking defect is any other module importing the writer.
- **Provider text is untrusted data.** Product names, brands and ingredient strings render as text,
  are never interpolated into a prompt in this phase, and carry the `data` marking §4.5 will rely on.
- Camera permission is requested at the scan tap, not at app load, and is never required to log.

## Test plan

**Unit** (vitest, colocated as the repo already does): `lib/barcode/gtin.test.ts` (check digits for
EAN-8, UPC-A, EAN-13, GTIN-14; leading-zero padding; rejects), `lib/barcode/quorum.test.ts`,
`lib/catalog/off-map.test.ts` (real OFF fixtures including an apple-in-ingredients pouch, a
missing-nutriments reject, an `energy_mismatch` case), `lib/catalog/fdc-map.test.ts`,
`lib/recipes/nutrients.test.ts` (per-serving maths, `yield_grams` fraction, null versus zero,
coverage), `lib/water.test.ts`, `lib/favorites.test.ts`.

**Integration**: barcode cache miss → one outbound fetch → catalog rows written → second request
serves from cache with zero outbound calls; a `miss` row inside 7 days makes no network call; OFF 404
and OFF timeout both fall through to FDC Branded, then to `not_found`; two catalog rows for one GTIN
return `ambiguous` in §4.1 order; a recipe edit under a stale `base_rev` produces a new revision and
never mutates the old one; a log made from revision 1 still reports revision 1's nutrients after an
edit; favorites union-merge across two simulated clients; two clients logging water for the same date
settle on the larger cup count; cross-user denial on `recipes`, `recipe_revisions`, `recipe_items`,
every favorites table and `user_prefs`; an MCP token cannot write a catalog row; export of each new
kind, with the ODbL notice and CSV escaping.

**Manual gate (Devin, on her phone).** Three packaged foods from her kitchen, each scanned and logged
in under 5 s from the + tap, timed. One of the three scanned again with airplane mode on, resolving
from cache. One pouch checked for its ingredient list and apple badge. One recipe saved with 4
servings, logged, then edited, with the earlier log unchanged. Water tapped to goal and confirmed on
the laptop after a sync.

## Acceptance criteria

1. `normalizeGtin` returns a valid GTIN-14 for every EAN-8, UPC-A, EAN-13 and GTIN-14 fixture and
   `null` for a bad check digit; `POST /api/foods/barcode` answers `400 invalid_gtin` for the latter.
2. A first scan of an uncached GTIN present in OFF returns `status: 'resolved'` and writes exactly one
   `catalog_versions`, one `catalog_foods`, one active `catalog_food_revisions` and one
   `catalog_barcodes` row.
3. A second request for the same GTIN returns `cached: true` and makes no outbound HTTP call.
4. An unknown GTIN returns `status: 'not_found'` with a `searchHint`, writes a `miss` lookup row, and
   a repeat within 7 days makes no outbound HTTP call.
5. With the network off, a previously scanned GTIN resolves from the IndexedDB catalog cache and logs.
6. Each of three packaged foods is logged in under 5 s, measured from the + tap to the entry appearing
   on Today (architecture §8 Phase 3 exit gate).
7. Saving an edited recipe creates `rev + 1`; the previous `recipe_revisions` row and every log that
   references it are byte-identical afterwards.
8. A recipe containing one item with an unmeasured nutrient reports `coverage < 1` and never reports
   that nutrient as `0`.
9. Two clients that each add a different favorite offline end with both favorites after sync.
10. Two clients logging 3 and 5 cups for the same date settle on 5 on both devices and on the server.
11. Every Phase 3 table refuses a read and a write from a second authenticated user, and
    `authenticated` holds no write grant on any `catalog_*` table.
12. `pnpm test`, `pnpm lint` and `pnpm build` are green, and an OFF-derived row renders the ODbL
    notice on the food detail screen and in a CSV export.

## Rollout and rollback

Order: migrations → `/api/foods/barcode` behind `NEXT_PUBLIC_FEATURE_SCAN=0` → sync op handlers →
client screens → flag on. One branch, one squashed commit, Vercel Git deploy from `main`.

The three migrations are additive and independent. Rollback is the matching `*_down.sql` plus turning
the flag off; no Phase 0–2 table is altered, so no log, food or day can be lost by reverting. The
barcode cache is derived data: dropping `catalog_barcode_lookups` and the OFF-sourced
`catalog_versions` rows costs only a re-fetch, and user `log_items` keep their snapshots regardless.
Water, favorites and recipes are client-side-first, so a server rollback leaves the phone's IndexedDB
copy intact and the outbox replays when the route returns.

A provider outage is not a rollback: the route keeps serving cached hits and returns
`upstream_unavailable` only for uncached codes.

## Open questions

1. ~~**OFF per-IP read rate limit** — architecture §10 defers this to Phase 3. Confirm the published
   limit before the flag goes on and record it here; `scripts/off-rate-probe.ts` measures it. Until
   then the outbound budget is 20/min/user.~~ — **measured 2026-09-12 (UTC), integration stage**:
   `scripts/off-rate-probe.ts` (30 sequential `v2/product` reads, our `SashaMealCompanion/0.1`
   user-agent, one residential IP) answered reads 1–11 (10 products + one 404) inside 4 s, then
   HTTP 429 from read 12 onward for the rest of the run; a 404 (unknown barcode) at read 22 still
   answered 404 while 429s surrounded it. A second run by hand gave 13 × 200 then 429. The 429
   carries no `Retry-After` and no `RateLimit-*` header. So the effective per-IP budget for product
   reads is **about 10 per minute**, well under the 100/min OFF documents, and the contracts §2
   outbound budget of 20/min/user cannot be served from one egress IP; on Vercel every user shares
   the function's IP. Consequences: keep the cache-first order as built (a cached hit never reaches
   OFF), keep `onOutbound` at or below 10/min, and treat a 429 as an outage (`error`, retried), never
   a miss. Confirm with OFF (or an API key / Product Opener account) if the limit is per-UA.
2. **Negative-cache window.** 7 days is a guess. A newly listed product would stay invisible that
   long. Shorter is friendlier and costs more fetches — Devin decides.
3. ~~**Does `user_prefs` belong to Phase 3?**~~ — **reconciled 2026-09-11**: no. `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §3 folds the goal into `user_settings.water_goal_cups` instead of a standalone table; see the reconciliation note above the `user_prefs` DDL in "Data changes". No lane creates `user_prefs`.
4. **Recipe yield.** `yield_grams` is optional and only converts "I ate 150 g of the tray" into a
   serving fraction. Cooked-weight capture on save is not in scope; confirm she does not need it.
5. **Favorites ceiling.** No cap is specified. A strip of 40 favorites stops being fast — propose a
   soft cap of 12 pinned plus a full list behind a tap.
6. **FDC Branded API key.** `api.nal.usda.gov` needs a key. Which vault id, and does the Phase 1
   import worker's key get reused for the runtime path or does the runtime get its own?
