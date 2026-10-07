# Phase 1 + 2 — Shared contracts (frozen 2026-09-11)

Extends `docs/plans/2026-09-10-phase-0/00-contracts.md` (Phase 0 contracts stay in force: auth helpers, sync types,
entity keys, `food_refs`, `get_or_create_food_ref`, conventions). Authority: `docs/architecture.md` v2.1 >
`docs/specs/phase-1-catalog.md` and `docs/specs/phase-2-real-logging.md` > this file > lane plans. A contract change
lands here first as `docs: phase-1-2 contract change — <what>`.

**Start condition:** Phase 0 release A is on `main` (auth, `user_foods`, `food_refs`, `user_food_prefs`, `log_entries`,
`log_items`, `catalog_*` shells, `change_log`, `apply_sync_op`). Lanes branch from that `main`. Real catalog rows arrive
only when Lane F's import runs; every other lane tests against fixture rows inserted by its own test helper.

## 1. Lanes and file ownership

| Lane | Owns | Branch |
|---|---|---|
| **F — Catalog data** | `supabase/migrations/20260912090000_catalog_tables.sql` (extensions `pg_trgm`, `unaccent`; `search_doc` tsvector column (worker-written via `catalog_search_doc`) + GIN; trigram GIN on `description || ' ' || coalesce(brand,'')`; `catalog_food_revisions` partial unique `(catalog_food_id) where is_active`; `catalog_versions.is_active` partial unique), `…090200_catalog_grants.sql` (RLS select-only on every `catalog_*`, revoke writes from `authenticated`), `…090050_catalog_activate.sql` (`catalog_activate_version(p_version_label text)`, `catalog_atwater_kcal(p_revision_id bigint)`), `scripts/catalog-dry-run.sh`, `scripts/catalog-size-report.sql`, `scripts/import-fdc.py`, `scripts/map-her-foods.py`, `docs/catalog/sizing.md`, `docs/catalog/her-foods-mapping.csv`, `docs/catalog/import.md`, `tests/catalog/**`, `~/Backups/usda/fdc/` (downloads, not in git) | `feat/p1-catalog-data` |
| **G — Search** | `supabase/migrations/20260912090100_catalog_search.sql` (`catalog_search` RPC, `security invoker`), `lib/search/query.ts`, `features.ts`, `thresholds.ts`, `gtin.ts`, `eval.ts` (+tests), `lib/server/catalog.ts`, `app/api/foods/search/route.ts`, `app/api/foods/[id]/route.ts`, `docs/catalog/labelled-queries.jsonl`, `scripts/search-eval.ts`, `scripts/apply-food-mapping.ts`, `tests/search/**` | `feat/p1-search` |
| **H — Logging server** | `supabase/migrations/20260918090000_phase2_log_item_guards.sql`, `…090100_phase2_compute_item_snapshot.sql`, `…090200_phase2_daily_totals.sql`, `…090300_phase2_catalog_dri_seed.sql` (SQL verbatim from the Phase 2 spec), `lib/nutrients/codes.ts`, `snapshot.ts`, `totals.ts`, `dri.ts`, `format.ts` (+tests), `lib/log/contract.ts`, `lib/log/grams.ts` (+tests), `lib/server/log.ts`, `app/api/log/commit/route.ts`, `lib/server/export.ts`, `app/api/export/route.ts` (extend Phase 0's route: streaming `meals` and `progress`), `lib/export/csv.ts` (add `csvDocument`, `ODBL_NOTICE`; keep Phase 0 exports), `app/api/mcp/route.ts` (`get_day` nutrients only), `scripts/verify-snapshots.ts`, `tests/log/**`, `tests/export/**` | `feat/p2-logging-server` |
| **I — Client** | `lib/catalog-client.ts`, `lib/db/catalog-cache.ts` (+tests), `components/CatalogSearch.tsx`, `FoodDetailSheet.tsx`, `NutrientBreakdown.tsx`, `DayNutrients.tsx`, `ExportCard.tsx`, `LogFoodSheet.tsx` (search/portion/grams rewrite), `LoggedExtras.tsx`, `MacroRings.tsx` (`consumed` from snapshots — props unchanged), `app/page.tsx` (mount `DayNutrients`), `app/settings/page.tsx` (mount `ExportCard`), `lib/store.ts` (log entries carry `items[]` with `grams` + `snapshot`; keep the Phase 0 outbox emission), `lib/resolve.ts` (totals from snapshots when present), `tests/client/**` | `feat/p2-client` |

Shared, nobody edits on a lane branch: `package.json` (deps — see §7), `DESIGN.md`, `app/globals.css`, `docs/architecture.md`, `lib/sync/**`, `lib/server/auth.ts`, `lib/server/privileged.ts`, `lib/server/admin.ts`. Lane I styles with the Lane E utilities only.

Lane order to land: **F → G → H → I** is the safest (each later lane's branch tests use the earlier one's rows), but every lane's unit work and route tests run against fixtures, so all four start together. G's relevance gate (≥ 85 / 95) is measured after F's import is active on the branch.

## 2. Catalog contracts (F produces; G, H, I consume)

Tables exactly as architecture §3.1 (shells shipped in Phase 0). Column names used across lanes:
`catalog_foods(id bigint, source, source_id)`, `catalog_food_revisions(id bigint, catalog_food_id, catalog_version_id,
description, brand, category, quality_class, quality_flags text[], prep_state text null, is_active bool, search_doc tsvector)`,
`catalog_versions(id, source, version_label, imported_at, row_counts jsonb, is_active)`, `catalog_nutrients(code text pk,
fdc_nutrient_id, name, unit, nutrient_group, derivation)`, `catalog_food_nutrients(food_revision_id, nutrient_code, amount_per_100g numeric null)`,
`catalog_portions(id, food_revision_id, description, gram_weight, is_default, seq)`, `catalog_ingredients(food_revision_id, seq, name, allergen_tags, raw_text)`,
`catalog_dri(nutrient_code, authority, ref_type, sex, age_min, age_max, life_stage, value, unit, effective_date)`, `catalog_barcodes(gtin14, catalog_food_id, source, published_at)`.

Canonical nutrient codes (H's `lib/nutrients/codes.ts` and F's import agree): `energy_kcal`, `energy_kcal_calc`, `protein`,
`carbohydrate`, `fat_total`, `fiber_total`, `sugars_total`, `sodium`, `potassium`, `calcium`, `iron`, `magnesium`, `zinc`,
`vitamin_c`, `vitamin_d`, `vitamin_b12`, `folate_dfe`, `vitamin_a_rae`, `saturated_fat`, `cholesterol`. Units: kcal, g, mg, µg.
`TRACKED_MICROS` = fiber_total, iron, calcium, potassium, magnesium, zinc, vitamin_c, vitamin_d, vitamin_b12, folate_dfe,
vitamin_a_rae, sodium (12). `NUTRIENT_UNITS` (`lib/nutrients/codes.ts`) maps every code to its unit; `DRI_FEMALE_19_30`
(`lib/nutrients/dri.ts`) carries the twelve seeded `DriRow` values. Both are Lane H exports; Lane I is their only Phase 2 consumer.

```sql
-- F
create function catalog_activate_version(p_version_label text) returns void;   -- security definer, service_role only
create function catalog_atwater_kcal(p_revision_id bigint) returns table (kcal numeric, complete boolean);
-- G (security invoker — RLS of the caller applies; user prior/eats come from the caller's own rows)
create function catalog_search(p_q text, p_brand text, p_prep text, p_limit integer)
  returns table (catalog_food_id bigint, revision_id bigint, description text, brand text, source text,
                 quality_class text, quality_flags text[], prep_state text, score numeric, pref_status text,
                 f_lexical numeric, f_trigram numeric, f_brand numeric, f_prep numeric, f_prior numeric, f_quality numeric, f_eats numeric);
```
Score — **exactly architecture §4.1, which carries the SQL** (contract corrected 2026-09-11; Lane G follows this):
`0.35·lexical + 0.20·trigram + 0.15·brand + 0.10·prep + 0.10·prior + 0.05·quality + 0.05·eats`;
`lexical = ts_rank(search_doc, websearch_to_tsquery('english', unaccent(q)), 32)`; `trigram = similarity(description, q)`;
`brand = 1.0` on exact normalised match, `0.6` when `similarity(brand, query_brand) ≥ 0.6`, else `0` (and `0` for every row when the
query has no brand token); `prep = 1.0` match, `0.5` when the query or the row has no prep, `0` on conflict;
`prior = least(1, ln(1 + logs_90d) / ln(21))`; `quality = analytical 1.0 / survey 0.75 / label 0.5 / crowd 0.25`, minus `0.25`
floored at `0` when `'energy_mismatch' ∈ quality_flags`; `eats = 1.0 eats / 0.5 unknown / 0.0 avoid`. `search_doc` is written by the
worker through the immutable `catalog_search_doc(description, brand, category)` function (Phase 1 spec), not a generated column.
GTIN exact match is a separate path (Phase 3).

Export kinds after Phase 2 (Lane H): Phase 0's `kind=progress` (weigh-ins) is renamed `kind=weight`; `kind=progress` becomes the daily
nutrient totals of the Phase 2 spec. `meals` keeps its name and gains the item columns.

## 3. Search wire types (G owns `lib/server/catalog.ts` types; I consumes)
Exactly the `FoodSearchRequest`, `FoodSearchHit`, `FoodSearchResponse`, `FoodDetail` types in `docs/specs/phase-1-catalog.md` (API changes). `CatalogSource = 'fdc_foundation'|'fdc_sr_legacy'|'fdc_fndds'|'fdc_branded'|'off'`; `PrepState = 'raw'|'cooked'|'roasted'|'grilled'|'fried'|'boiled'|'baked'|'unknown'`. `503` when no active `catalog_versions` row → the client falls back to `lib/food-db.json` and labels results "offline results".

## 4. Logging wire types (H owns `lib/log/contract.ts`; I consumes)
Exactly `LogItemInput`, `LogCommitRequest`, `LogCommitResponse`, `LogCommitFailure` from `docs/specs/phase-2-real-logging.md`.
`Snapshot`, `NutrientValue`, `computeSnapshot`, `totalsFor`, `microCoverage`, `percentDri`, `fiberBandState`, `formatAmount`,
`gramsForPortion`, `gramsFromUnit` as in that spec's Engines section. `applyLogEntry(admin|client, userId, req): Promise<LogCommitResponse | LogCommitFailure>`
is the single writer, used by the commit route and by the sync applier (`apply_sync_op` for `log_entries` calls `compute_item_snapshot` in SQL; H adds that in `…090100`).
`DayTotals = { local_date: string; nutrients: NutrientTotal[]; micro_coverage_pct: number }`.
`SnapshotMeta = { source: string; source_version: string; revision_id: number | null; units?: Partial<Record<NutrientCode, string>> }`.

## 5. Client contracts (I)
- `lib/db/catalog-cache.ts`: IndexedDB store `catalog_revisions` in the Phase 0 `smc` database (bumped to v2 on the integration branch; store name exported as `CATALOG_STORE`, keyPath `revision_id`, index `by_cached_at`), keyed by `revision_id`, value `{ revision_id, catalog_food_id, description, brand, source, version_label, per_100g: Record<code, number|null>, portions[] , cached_at }`; `getRevision(id)`, `putRevision(row)`, `evictOlderThan(days)`.
- Feature flag `NEXT_PUBLIC_CATALOG_SEARCH=1` switches the log sheet to `/api/foods/search`; unset = Phase 0 behavior exactly. Baked at build; a rollback is a redeploy (Phase 0 note).
- `lib/store.ts` extras gain `items?: { id, seq, food_ref_id, grams, qty, unit, snapshot }[]`; legacy extras without `items` keep rendering.

## 6. Env and scripts
`CATALOG_IMPORT_DB_URL` (worker only, never Vercel) — already in `.env.example`; `NEXT_PUBLIC_CATALOG_SEARCH`. Scripts: Python 3.12 with `psycopg[binary]` for `import-fdc.py` / `map-her-foods.py` (declare in `scripts/requirements.txt`, Lane F); TypeScript scripts via `pnpm exec tsx`.

## 7. Pre-lane setup on `main` (done once): no new npm dependencies for Phase 1–2 (zod, idb, @supabase/ssr already present). Lane F adds `scripts/requirements.txt`; `pip install -r scripts/requirements.txt` in a `.venv` is the worker's own setup.

## 8. Conventions
OFF lookup (Phase 3) and later AI prompts borrow from fud-ai (MIT) per each spec's 'Reference implementation' section; ported text is recorded in `NOTICE.md`.

## 8a. Conventions (Phase 0)
Phase 0 §8 applies. Add: every SQL function that reads user rows is either `security invoker` (browser path) or `security definer` with `p_user_id` first and execute revoked from `authenticated` (privileged path) — never both, never neither.
