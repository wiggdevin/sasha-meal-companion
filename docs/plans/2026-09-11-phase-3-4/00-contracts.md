# Phase 3 + 4 — Shared contracts (frozen 2026-09-11, wave 3)

Extends `docs/plans/2026-09-10-phase-0/00-contracts.md` and `docs/plans/2026-09-11-phase-1-2/00-contracts.md`
(both stay in force: auth helpers, sync envelope, entity keys, catalog columns, nutrient codes, logging wire types).
Authority: `docs/architecture.md` v2.1 > `docs/specs/phase-3-fast-capture.md` and `docs/specs/phase-4-ai-capture.md` >
this file > lane plans. Where this file names something the spec names differently, this file wins **only** because it
reconciles the spec with code that already landed (each such case is marked "reconciled"). A contract change lands here
first as `docs: phase-3-4 contract change — <what>`.

**Start condition:** `main` at or after PR #27 (Phases 1–2 landed: `catalog_*` populated on a branch, `catalog_search`,
`compute_item_snapshot`, `applyLogEntry`, `/api/log/commit`, `LoggedItem` with snapshots, `lib/db/catalog-cache.ts`).
Phase 0 already created `recipes`, `recipe_revisions`, `recipe_items`, `favorites_foods`, `favorites_recipes`,
`favorites_meals`, `favorites_meal_items`, `constraint_profiles`, `ai_calls` (with `status`/`error` columns) and their RLS
policies — the Phase 3 spec's "Data changes" DDL for those tables is therefore **already applied**; lanes only ALTER.

## 0. Pre-lane setup on `main` (done once by the planner before any lane branches)

1. `pnpm add zxing-wasm` (barcode decoder, Apache-2.0) and a `postinstall` script line `node scripts/copy-zxing-wasm.mjs`
   in `package.json`; `public/zxing/` added to `.gitignore` (the `.wasm` is copied from `node_modules` at install, never
   committed, never fetched from a CDN).
2. `lib/capture/types.ts` — the Phase 4 wire types verbatim (§5 below), pure TypeScript, no imports beyond zod.
3. `lib/capture/flags.ts` — `enabledMethods()`, `isMethodEnabled(m)` (§6 below), tested.
4. `lib/policy/constraints.ts` — the §4.4 deterministic policy (§4 below), tested.
5. `.env.example` gains `FDC_API_KEY`, `NEXT_PUBLIC_CAPTURE_METHODS`, `CAPTURE_DAILY_SOFT_CAP`; `AGENTS.md` phase table updated.

Lanes consume these as landed code. Nobody edits `package.json`, `lib/capture/types.ts`, `lib/capture/flags.ts` or
`lib/policy/constraints.ts` on a lane branch (a needed change is a contract change).

## 1. Lanes and file ownership

| Lane | Owns (create/modify only these) | Branch |
|---|---|---|
| **K — Barcode + provider cache** (Phase 3) | `lib/log/contract.ts` (add `"barcode"` to `METHODS` only), `lib/log-client.ts` (optional `method` on `buildCommitRequest` only), `supabase/migrations/20260919090100_phase3_barcode_cache.sql` (+ `supabase/migrations/down/…_down.sql`), `lib/barcode/gtin.ts`, `lib/barcode/quorum.ts`, `lib/barcode/worker.ts`, `lib/barcode/scan-cache.ts`, `lib/barcode/client.ts`, `lib/catalog/off.ts`, `lib/catalog/fdc.ts`, `lib/catalog/off-map.ts`, `lib/catalog/fdc-map.ts`, `lib/server/catalog-writer.ts`, `lib/server/barcode.ts`, `app/api/foods/barcode/route.ts`, `components/BarcodeScanSheet.tsx`, `components/ScanConfirmSheet.tsx`, `app/scan/page.tsx`, `scripts/copy-zxing-wasm.mjs`, `scripts/off-rate-probe.ts`, `lib/db/catalog-cache.ts` (add `gtin14` + `getByGtin`), `tests/barcode/**`, `NOTICE.md` (add the fud-ai OFF-field row) | `feat/p3-barcode` |
| **L — Recipes, favorites, water** (Phase 3) | `supabase/migrations/20260919090000_phase3_recipes_favorites.sql`, `…090200_phase3_water_goal.sql`, `…090300_phase3_sync_entities.sql` (+ down files), `lib/sync/types.ts`, `lib/sync/keys.ts`, `lib/sync/merge.ts`, `lib/sync/idb.ts` (DB_VERSION 3 only — stores come from `ENTITIES`), `lib/recipes/nutrients.ts`, `lib/water.ts`, `lib/favorites.ts`, `lib/recipes-client.ts`, `lib/favorites-client.ts`, `lib/water-client.ts`, `components/FavoritesStrip.tsx`, `components/RecipeSheet.tsx`, `components/RecipeItemRow.tsx`, `components/WaterCard.tsx`, `app/recipes/page.tsx`, `app/foods/page.tsx` (mount `FavoritesStrip`), `lib/server/export.ts` + `app/api/export/route.ts` (kinds `recipes|favorites|water`), `lib/export/csv.ts` (only if a helper is missing), `tests/recipes/**`, `tests/favorites/**`, `tests/water/**`, `tests/sync/phase3-*.test.ts`, `tests/export/phase3-*.test.ts` | `feat/p3-recipes-favorites-water` |
| **M — Capture server** (Phase 4) | `supabase/migrations/20260920090000_phase4_ai_calls_capture.sql`, `…090100_phase4_media_bucket.sql` (+ down files), `lib/ai/adapter.ts` (extend only: multimodal parts, Files API path, new `status` values, `purpose` widening), `lib/ai/json-schema.ts`, `lib/ai/schemas.ts`, `lib/ai/prompts.ts`, `lib/ai/capture.ts`, `lib/ai/spend.ts`, `lib/media/validate.ts`, `lib/server/media.ts`, `lib/capture/quantity.ts`, `lib/capture/grounding.ts`, `lib/capture/propose.ts`, `lib/server/capture.ts`, `app/api/media/sign/route.ts`, `app/api/log/propose/route.ts`, `app/api/log/commit/route.ts` + `lib/server/log.ts` (extend: `draft_id`, `save_label_as_food`, media delete on commit), `app/api/jobs/media-sweep/route.ts`, `vercel.json` (cron), `lib/server/catalog.ts` (add `policy` to `FoodSearchHit` and `FoodDetail`), `scripts/ai-eval.ts`, `scripts/eval/phase-4-capture.jsonl`, `docs/evals/`, `docs/ai-data-handling.md` (append the audio-container canary result), `tests/capture/**`, `tests/media/**`, `NOTICE.md` (add the fud-ai prompt-shape row) | `feat/p4-capture-server` |
| **N — Capture client** (Phase 4) | `components/CaptureSheet.tsx`, `components/CaptureConfirm.tsx`, `components/VoiceCapture.tsx`, `components/PhotoCapture.tsx`, `components/LoggedExtras.tsx` (method glyph + "check this" hint), `lib/media/resize.ts`, `lib/capture-client.ts`, `lib/capture/drafts.ts`, `tests/client/capture-*.test.ts`, `docs/screenshots/phase-4/` | `feat/p4-capture-client` |
| **O — Search recall** (Phase 1 AC8 unblock) | `supabase/migrations/20260921090000_catalog_synonyms.sql` (+ down), `docs/catalog/synonyms.csv`, `scripts/load-synonyms.ts`, `lib/search/query.ts` (query expansion + typo fold), `lib/search/features.ts` (only if a feature mapping must mirror new SQL), `tests/search/recall.test.ts`, `docs/catalog/relevance.md` (append the re-measurement) | `feat/p1-search-recall` |

Shared, nobody edits on a lane branch: `package.json`, `pnpm-lock.yaml`, `DESIGN.md`, `app/globals.css`, `app/design-tokens.css`,
`docs/architecture.md`, `lib/capture/types.ts`, `lib/capture/flags.ts`, `lib/policy/constraints.ts`, `lib/server/auth.ts`,
`lib/server/privileged.ts`, `lib/server/admin.ts`, `lib/server/http.ts`, `lib/server/ratelimit.ts`, `lib/log/contract.ts` (except Lane K's `METHODS` addition),
`lib/nutrients/**`, `lib/types.ts`, `lib/store.ts`, **`app/page.tsx`, `components/QuickActions.tsx`, `components/LogFoodSheet.tsx`**
(Today's wiring is an integration-stage task — see §9; each UI lane ends with a "Hand-off to integration" section carrying the
exact ≤ 15-line mount diff for these three files). Lanes style only with the utilities in `app/globals.css` and the `DESIGN.md`
tokens; no new colours, no new npm dependencies.

Land order that keeps branch tests honest: **K → L → M → N**, O whenever green. Every lane's unit work runs on fixtures, so all
five start together. M's tests consume `lib/policy/constraints.ts` (pre-lane, on main) and K's `catalog-writer` only through the
contract signatures below; N consumes M's routes only through `lib/capture/types.ts`.

## 2. Barcode contracts (K produces; N and integration consume)

Migration `20260919090100_phase3_barcode_cache.sql`: `catalog_barcode_lookups` verbatim from the Phase 3 spec (no RLS, `grant select
… to authenticated`, index on `last_fetched_at`).

```ts
// lib/barcode/gtin.ts  (reconciled: lib/search/gtin.ts already ships toGtin14 — reuse it, never duplicate the check-digit code)
export { toGtin14 as normalizeGtin } from "@/lib/search/gtin";
export function gtinCheckDigit(body13: string): number;          // mod-10 over 13 digits
export function isGtin(raw: string): boolean;                    // normalizeGtin(raw) !== null

// lib/barcode/quorum.ts
export type Reading = { text: string; format: string; at: number };
export function acceptReading(history: Reading[], next: Reading, quorum?: number): string | null;  // default quorum 2 within 1500 ms

// lib/catalog/off-map.ts, lib/catalog/fdc-map.ts
export type RevisionDraft = { description: string; brand: string | null; qualityClass: "crowd" | "label";
  per100g: Record<NutrientCode, number | null>; portions: { description: string; gramWeight: number }[];
  ingredients: { seq: number; name: string; allergenTags: string[] }[]; ingredientsText: string | null;
  qualityFlags: string[]; sourceId: string; publishedAt: string };
export function offToRevision(p: OffProduct, fetchedAt: string): RevisionDraft | { reject: string };
export function fdcBrandedToRevision(f: FdcBrandedFood, fetchedAt: string): RevisionDraft | { reject: string };

// lib/catalog/off.ts, lib/catalog/fdc.ts — the ONLY modules that reach the network for provider data
export const OFF_HOST = "world.openfoodfacts.org";  export const FDC_HOST = "api.nal.usda.gov";
export const OFF_USER_AGENT = "SashaMealCompanion/0.1 (https://sasha-meal-companion.vercel.app)";
export async function fetchOffProduct(gtin14: string, deps?: { fetchFn?: typeof fetch }): Promise<OffProduct | { status: 404 | 429 | 5xx | "timeout" }>;
export async function fetchFdcBranded(gtin14: string, deps?: { fetchFn?: typeof fetch }): Promise<FdcBrandedFood | { status: ... }>;
// 5 s timeout, `redirect: "error"`, no image URL is ever fetched. FDC needs FDC_API_KEY (env, Vercel + .env.local; never logged).

// lib/server/catalog-writer.ts — the ONLY request-path writer of catalog_* (imports lib/server/admin.ts)
export async function writeProviderRevision(admin: SupabaseClient, source: "off" | "fdc_branded", gtin14: string,
  draft: RevisionDraft, userId: string): Promise<{ catalogFoodId: number; revisionId: number; versionLabel: string }>;
// (contract change 2026-09-11) the write runs in ONE transaction through the RPC
// catalog_write_provider_revision(p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb) returns jsonb — security definer,
// service_role only, p_user_id first like every RPC in the repo, because get_or_create_food_ref requires _sync_assert_caller(p_user_id).
// one catalog_versions row per (source, fetch date) with version_label `${source}-${YYYY-MM-DD}` and is_active = false
// (provider rows are NOT the bulk version; catalog_search's "active version" test is per revision, so the revision is
// is_active = true and the catalog_foods identity is keyed (source, source_id = gtin14)); writes nutrients, portions,
// ingredients, catalog_barcodes(gtin14, catalog_food_id, source, published_at); calls get_or_create_food_ref('catalog', …).
// Re-fetch of a known identity activates a new revision and deactivates the old one; identities are never rewritten.

// lib/server/barcode.ts
export async function resolveBarcode(client: SupabaseClient, admin: SupabaseClient, userId: string, req: BarcodeRequest,
  deps?: ProviderDeps): Promise<BarcodeResponse>;   // resolution order exactly as the spec's "API changes"
```

Wire types `BarcodeRequest`, `BarcodeMatch`, `BarcodeResponse`, `BarcodeError` exactly as the Phase 3 spec, with
`BarcodeMatch.policy` computed by `evaluatePolicy` (§4) from the user's `constraint_profiles` row (default row when absent).
Route `POST /api/foods/barcode`: `enforceRateLimit('barcode:'+userId, 120, 60)` → `requireUser` → `readJson(…, 8 KB)` → a second
`enforceRateLimit('barcode:out:'+userId, 20, 60)` only on the path that reaches a provider → `jsonError`. Negative-cache window
**7 days** (spec open question 2 — ASSUMED until Devin rules), refresh threshold 90 days, refresh never on the hot path.

Client: `lib/barcode/worker.ts` wraps `zxing-wasm/reader` in a Web Worker (`readBarcodes` on `ImageData`, formats
`EAN-8, UPC-A, UPC-E, EAN-13, ITF, Code-128`); `lib/barcode/client.ts` exports `scanGtin(req: BarcodeRequest): Promise<BarcodeResponse>`
(online) and `resolveOffline(gtin14): Promise<CachedRevision | null>`; `lib/barcode/scan-cache.ts` keeps GTIN → revision in the
existing `catalog_revisions` store by adding `gtin14?: string` to `CachedRevision` (index-free lookup over ≤ 500 rows) and pending
offline scans under `localStorage` key `smc:pending_scans` (`{ gtin14, at }[]`, replayed on `online`). `components/BarcodeScanSheet.tsx`
(camera, torch, 44 px cancel; `getUserMedia({ video: { facingMode: "environment" } })` requested on open, never at app load) and
`components/ScanConfirmSheet.tsx` (product, brand, ingredients, allergen badge, portion picker, qty `Stepper`, star, **Log it** → Phase 2
`commitLogEntry` from `lib/log-client.ts` with `method: 'barcode'`). (Contract change 2026-09-11) Lane K owns two narrow edits to
otherwise-shared files so that method reaches the wire: `lib/log/contract.ts` — add `"barcode"` to `METHODS` (the `log_entries.method`
check already allows it; nothing else in the file changes); `lib/log-client.ts` — `buildCommitRequest` gains an optional `method`
argument defaulting to `"search"`. Every existing test in both files stays green. `app/scan/page.tsx` is the standalone entry (full screen) so the
flow is testable on the phone before Today is wired. Feature flag `NEXT_PUBLIC_FEATURE_SCAN=1` gates the scan action and the route
page; unset = no scan UI, route answers 404.

## 3. Recipes, favorites, water contracts (L produces)

**Reconciled data changes.** Tables and RLS exist (Phase 0). `20260919090000_phase3_recipes_favorites.sql` only adds:
`favorites_foods`, `favorites_recipes`: `rev integer not null default 1`, `updated_at timestamptz not null default now()`,
`created_at timestamptz not null default now()` (set once at insert, never touched by `_sync_upsert`'s on-conflict path — the export's
`added_at`; contract change 2026-09-11), `deleted_at timestamptz` (tombstones, so a removed favorite is not resurrected by set-union
merge — "deletes dominate"); `favorites_meals`: `updated_at`, `created_at`, `deleted_at`; `recipes`: `updated_at timestamptz not null default now()`.
`20260919090200_phase3_water_goal.sql` (reconciled: spec open question 3 — no `user_prefs` table):
`alter table user_settings add column water_goal_cups integer not null default 8 check (water_goal_cups between 1 and 30)`,
and `_sync_upsert` / `_sync_current` for `user_settings` carry the column (`create or replace` in `…090300`).

`20260919090300_phase3_sync_entities.sql` replaces `_sync_assert_key`, `_sync_current`, `_sync_upsert`, `_sync_tombstone` and
`apply_sync_op` (`create or replace`, same signatures, Phase 0 semantics unchanged for existing entities) to add:

| Entity | `entity_key` | Payload (create/update) | Server rule |
|---|---|---|---|
| `recipes` | uuid `id` | `{ name, servings, yield_grams?, items: [{ seq, food_ref_id, qty, unit, grams, state, food_revision_id? }] }` | every applied create/update inserts a **new** `recipe_revisions` row with `rev = <new recipes.rev>`, items into `recipe_items`, `nutrients_per_serving` computed in SQL from `compute_item_snapshot(food_ref_id, grams)` per item ÷ servings (null stays null; `coverage` = items with a value ÷ items, stored as `nutrients_per_serving.coverage`); also upserts `user_foods(id = recipe id, kind = 'recipe', name, per_100g = whole-recipe totals × 100 ÷ total grams)` and `get_or_create_food_ref('user', recipe id)`, so a recipe is loggable through the unchanged Phase 2 commit path (grams = `servingGrams × servings eaten`). Tombstone-capable. `current` = recipe row ∥ `{ revision_id, revision_rev, nutrients_per_serving, items[] }` of the latest revision. |
| `favorites_foods` | `food_ref_id` uuid | `{ sort }` | upsert on `(user_id, food_ref_id)`; tombstone-capable |
| `favorites_recipes` | `recipe_id` uuid | `{ sort }` | upsert on `(user_id, recipe_id)`; tombstone-capable |
| `favorites_meals` | uuid `id` | `{ name, sort, items: [{ seq, food_ref_id, grams }] }` | items replaced wholesale (like `log_items`); tombstone-capable; `current` carries `items[]` inline |
| `water_log` | (exists) | `{ cups }` | **server-side max**: `on conflict … set cups = greatest(water_log.cups, excluded.cups)` (reconciled: Phase 0 wrote `excluded.cups`; the client merge already takes the max, the server now agrees) |

`apply_sync_op`'s delete/restore allowlist becomes `user_foods, log_entries, gut_log, recipes, favorites_foods, favorites_recipes, favorites_meals`.
Conflict on `recipes` follows §3.7: the client rebases as a new revision on `current_rev` (no field merge) — `mergeEntity('recipes', …)`
returns the local payload unchanged. `favorites_*`: `mergeEntity` returns the union rule's result per row (`sort` newer `client_ts`).

```ts
// lib/sync/types.ts — additions
export type Entity = … | "recipes" | "favorites_foods" | "favorites_recipes" | "favorites_meals";
export const ENTITIES = [ …existing, "recipes", "favorites_foods", "favorites_recipes", "favorites_meals" ] as const;
// lib/sync/keys.ts: recipes, favorites_meals → lowercase uuid `id`; favorites_foods → `food_ref_id`; favorites_recipes → `recipe_id`.
// lib/sync/idb.ts: DB_VERSION = 3 (the upgrade loop over ENTITIES creates the four stores; nothing else changes).

// lib/recipes/nutrients.ts, lib/water.ts, lib/favorites.ts — exactly the Phase 3 spec "Engines and logic" signatures.
export type RecipeItemInput = { seq: number; foodRefId: string; qty: number; unit: string; grams: number; state: "raw" | "cooked"; foodRevisionId?: number | null };
export type Per100gByRef = Record<string, Record<NutrientCode, number | null>>;
```

Client modules: `lib/recipes-client.ts` (`saveRecipe(input): Promise<{ recipeId; rev }>` — writes IndexedDB `recipes` store, enqueues the op
via `lib/sync/outbox.ts enqueue`, computes a provisional `nutrients_per_serving` from `lib/db/catalog-cache.ts` rows for display),
`lib/favorites-client.ts` (`toggleFavorite(kind, id)`, `listFavorites(): Promise<FavoriteRow[]>` ordered by `sort`), `lib/water-client.ts`
(`addCups(localDate, delta)`, `setGoal(cups)` → `user_settings` op; the legacy `logWater()` in `app/page.tsx` is rewired at integration).
Screens per the spec "Client changes" (`FavoritesStrip` on Foods and — at integration — inside the log sheet; `RecipeSheet` shows
"Saving creates version N+1"; `WaterCard` + and − steppers against `water_goal_cups`).

Export (`/api/export`, Lane L): `kind=recipes` (one row per recipe **revision** item: recipe_id, name, revision_rev, created_at, servings,
seq, food_ref_id, description, grams, per-serving kcal/protein/carbohydrate/fat_total/fiber_total), `kind=favorites` (kind, id, name, sort,
added_at = `created_at`), `kind=water` (local_date, cups, goal). Same paging and `escapeCell`; attribution uses the Phase 2 `notices[]`
mechanism (a `notices` array in JSON, trailing `# …` comment lines in CSV) exactly as `streamMeals` already ships it — the ODbL notice is
added when any row's food source is `off` (contract change 2026-09-11: not a per-row column).

## 4. Constraint policy (pre-lane on main; K, M, O consume)

```ts
// lib/policy/constraints.ts — architecture §4.4, pure
export type ConstraintProfile = { avoid_allergens: string[]; avoid_food_ref_ids: string[]; banned_categories: string[] };
export const DEFAULT_PROFILE: ConstraintProfile = { avoid_allergens: ["gluten","dairy","apple"], avoid_food_ref_ids: [], banned_categories: ["simple_sugars"] };
export type PolicyEvidence = { foodRefId: string | null; allergenTags: string[] | null; category: string | null; onEatsList: boolean };
export type PolicyVerdict = { verdict: "allowed" | "blocked" | "unverified"; reason?: string };
export function evaluatePolicy(profile: ConstraintProfile, e: PolicyEvidence): PolicyVerdict;
// blocked when allergenTags ∩ avoid_allergens ≠ ∅ (reason "allergen:<tag>"), foodRefId ∈ avoid_food_ref_ids ("avoid_list"),
// category ∈ banned_categories ("category:<c>"); unverified when allergenTags is null and !onEatsList; else allowed.
export function loadProfile(row: Partial<ConstraintProfile> | null): ConstraintProfile;  // null → DEFAULT_PROFILE
```
Server callers read `constraint_profiles` for `auth.uid()` through the request-local client (RLS) — `select … maybeSingle()` — and
pass `loadProfile(row)`. Lane M adds `policy: PolicyVerdict` to `FoodSearchHit` and `FoodDetail` (allergen evidence from
`catalog_ingredients`; `onEatsList` from `user_food_prefs.status = 'eats'`); the client renders an amber pill for `unverified`
and a red pill for `blocked`.

## 5. Capture wire types (pre-lane on main, `lib/capture/types.ts`; M implements, N consumes)

Exactly the Phase 4 spec §5 types: `SignRequest`, `SignResponse`, `ProposeRequest`, `DraftItem`, `ProposeResponse`, plus zod schemas
`signRequestSchema`, `proposeRequestSchema`. **Commit is Phase 2's `LogCommitRequest`** (snake_case, `lib/log/contract.ts`) — no new
commit type; `draft_id` and `save_label_as_food` already exist there. `ProposeResponse.labelFood` is present only for `method: 'label'`.
`DraftItem.policy` is a `PolicyVerdict` (§4). Error bodies are `{ error, message }` with the spec's status table; `409 duplicate_request`
carries `{ error: "duplicate_request", message, aiCallId }`.

**Reconciled `ai_calls`.** Phase 0's table has `status text not null default 'ok'` and `error text` (added in `…000700`), and the
adapter writes `purpose` as the adapter's `Purpose` keys (`textToItems`, `voiceToItems`, `labelToNutrients`, `photoToItems`, `coach`,
`weeklyReview`). Phase 4 keeps both: **no `outcome` column** — `status` widens to `'ok' | 'schema_invalid' | 'provider_error' | 'timeout'
| 'blocked' | 'error'` (a `check` constraint added by M's migration), `purpose` stays the adapter keys. Idempotency is a **route check,
not a unique index** (a 10-minute window cannot be an index): `…090000_phase4_ai_calls_capture.sql` adds
`create index ai_calls_idem on ai_calls (user_id, purpose, input_hash, created_at desc) where status = 'ok'` and
`ai_calls_today(p_user_id uuid, p_tz text) returns integer` (spec SQL, counting `status = 'ok'`). Propose: if an `ok` row with the
same `(user_id, purpose, input_hash)` exists within 10 minutes → 409 before any provider call.

```ts
// lib/ai/adapter.ts — additions only (M)
export type StructuredArgs<T> = GenerateArgs<T> & { media?: { bytes: Uint8Array; mimeType: string } };  // inline < 4 MB else Files API
export type AiStatus = "ok" | "schema_invalid" | "provider_error" | "timeout" | "blocked" | "error";
// generateStructured writes `status` per attempt outcome; the provider file is deleted in a `finally` on the Files API path.
// Provider override (added 2026-09-11 for Phase 7): `GenerateArgs.provider?: "gemini" | "nous"`. When set it replaces the
// NOUS_PURPOSES routing for that call; the model is MODELS[purpose] when the provider is the purpose's home, else
// FALLBACK_MODELS[purpose]. `export const FALLBACK_MODELS = { coach: "gemini-3.8-flash", weeklyReview: "gemini-3.8-flash" } as const`
// (architecture §6); an override for any other purpose throws. The ai_calls row records the provider and model actually used.

// lib/ai/json-schema.ts (M)
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown>;  // from z.toJSONSchema; strips $schema; throws on oneOf/$ref/additionalProperties:true
export function assertSupported(schema: z.ZodType): void;

// lib/ai/schemas.ts (M): textItemsSchema, voiceItemsSchema, labelNutrientsSchema, photoItemsSchema  (one zod schema per purpose)
// lib/ai/prompts.ts (M): PROMPTS[purpose] = { system: string; maxOutputTokens: number }  (data-field marking per §4.5; no tools, no URLs)

// lib/capture/quantity.ts, grounding.ts, propose.ts, lib/ai/spend.ts — exactly the spec §7 signatures.
export function pickCandidate(hits: ScoredHit[], cls: "branded" | "generic"): { hit: ScoredHit; autoResolved: boolean } | null;
// uses shouldAutoResolve from lib/search/thresholds.ts — thresholds are never lowered by this lane (see §8 on the gate)

// lib/server/capture.ts (M)
export async function proposeDraft(client: SupabaseClient, admin: SupabaseClient, userId: string, req: ProposeRequest,
  deps?: CaptureDeps): Promise<ProposeResponse>;
// lib/server/media.ts (M)
export async function signUpload(client, userId, req: SignRequest): Promise<SignResponse>;      // path media/<uid>/<uuid>.<ext>
export async function fetchOwnedObject(admin, userId, path): Promise<{ bytes: Uint8Array; mimeType: string }>;  // 403 media_not_owned
export async function deleteMedia(admin, path): Promise<void>;
// lib/media/validate.ts (M) — pure
export function validateImage(bytes: Uint8Array, declared: string): { ok: true; width: number; height: number } | { ok: false; reason: string };  // magic bytes, ≤ 4000 px
export function validateAudio(bytes: Uint8Array, declared: string): { ok: true; seconds: number } | { ok: false; reason: string };            // ≤ 30 s
```

Routes (M): `/api/media/sign` (1 KB, 30/min), `/api/log/propose` (8 KB, soft/hard daily caps from `ai_calls_today`: soft
`CAPTURE_DAILY_SOFT_CAP` default 30 → `spend.usedToday ≥ softCap` sets a warning note; hard `CAPTURE_DAILY_HARD_CAP` default 100 →
429 `spend_cap` and an `ai_calls` row with `status = 'blocked'`; `0` stops all provider spend), `/api/log/commit` (extend: when
`draft_id` present and `method ∈ text|voice|label|photo`, delete `media_objects` for the entry's `media_ref` after apply; when
`save_label_as_food`, insert `user_foods(kind='label_scan')` + food_ref first and use it for the item; a second commit with the same
`entry_id` is the Phase 2 duplicate path unchanged), `/api/jobs/media-sweep` (`Authorization: Bearer $CRON_SECRET`, hourly via
`vercel.json` `{ "crons": [{ "path": "/api/jobs/media-sweep", "schedule": "0 * * * *" }] }`). Media bucket id is the literal `'media'`.

Client (N): `lib/capture-client.ts` — `captureText(text, ctx)`, `captureMedia(kind, blob, ctx)` (sign → `PUT uploadUrl` → propose),
`commitDraft(draft, edits, ctx)` → Phase 2 `commitLogEntry`; `lib/capture/drafts.ts` — drafts persist in `localStorage` under
`smc:draft:<draftId>` (≤ 64 KB, cleared on commit/dismiss; reconciled: idb.ts is Lane L's file this wave); `lib/media/resize.ts` —
`resizeImage(file, { longEdge: 1600, quality: 0.8 }): Promise<Blob>` via canvas (EXIF dropped by re-encode); `VoiceCapture` uses
`MediaRecorder` with the first supported of `audio/mp4`, `audio/aac`, `audio/webm` and a 30 s hard stop; offline → the four actions
render disabled with "needs a connection". Every tap target ≥ 44 px; copy per `DESIGN.md`; method glyphs are 1.5 px linear SVG.
`CaptureSheet` props (N; the Phase 7 coach reuses the sheet for its drafts): `{ open: boolean; initialMode: CaptureMethod | "confirm";
initialDraft?: ProposeResponse; onClose(): void; onLogged(entryId: string): void; onOpenSearch(): void }` — with `initialMode: "confirm"`
and an `initialDraft`, the sheet opens straight on `CaptureConfirm` and skips capture.

## 6. Flags and env

| Name | Where | Meaning |
|---|---|---|
| `NEXT_PUBLIC_FEATURE_SCAN` | build-time | `1` renders the scan action and `/scan`; unset = no scan UI (Phase 3) |
| `CAPTURE_METHODS` | server | comma list of `text,voice,label,photo`; a method absent → its propose branch is 404 |
| `NEXT_PUBLIC_CAPTURE_METHODS` | build-time | the same list for the client bundle (set both to the same value) |
| `CAPTURE_DAILY_SOFT_CAP` / `CAPTURE_DAILY_HARD_CAP` | server | per-user successful proposes per local day; defaults 30 / 100; hard `0` = off |
| `FDC_API_KEY` | server | FDC Branded lookup (Lane K); value in Vercel + `.env.local` only |
| `CRON_SECRET`, `GEMINI_API_KEY`, `AI_DAILY_SPEND_CAP_USD` | server | existing |

```ts
// lib/capture/flags.ts (pre-lane)
export type CaptureMethod = "text" | "voice" | "label" | "photo";
export function enabledMethods(env: Record<string, string | undefined> = process.env): CaptureMethod[];  // CAPTURE_METHODS ?? NEXT_PUBLIC_CAPTURE_METHODS ?? ""
export function isMethodEnabled(m: CaptureMethod, env?): boolean;
```

## 7. Search recall (Lane O) — unblocking Phase 1 AC8 without touching the §4.1 score

`docs/catalog/relevance.md` (2026-09-11) measured top-1 42.6 % / top-3 77.1 % and named two causes outside the score: candidate
**recall** (the `similarity > 0.25` gate drops the right row) and **no synonym layer** ("albacore" = "tuna, white"). Lane O fixes
recall and vocabulary only; weights, mappings and thresholds in §4.1 stay byte-identical, and `catalog_search`'s signature and
return columns do not change (M and K read it unchanged).

- `20260921090000_catalog_synonyms.sql`: `catalog_synonyms(term text primary key, expansion text not null, source text not null default 'curated')`
  (no RLS; `grant select … to authenticated`); `create or replace function catalog_search(...)` with the candidate set widened to
  `search_doc @@ tsq OR similarity(description, raw) > 0.25 OR word_similarity(raw, description) > 0.45 OR search_doc @@ to_tsquery('english', <expanded terms>)`,
  where expansion joins `catalog_synonyms` on each query token; the score expression is unchanged.
- `docs/catalog/synonyms.csv` seeded from the 14 misses + the unresolved 5 (`albacore → tuna white`, `eggs → egg whole raw`, `white rice → rice white long-grain`,
  `sweet potato → sweet potato raw`, `pumpkin puree → pumpkin canned`, `chkn → chicken`, `brst → breast`, …); `scripts/load-synonyms.ts` upserts it.
- `lib/search/query.ts`: `expandQuery(q, synonyms)` and a typo fold that maps a token to its nearest description word when
  `word_similarity ≥ 0.6` (client-side mirror for the TS features only where SQL changes force it).
- Gate: re-run `scripts/search-eval.ts` on the branch; report the new numbers in `docs/catalog/relevance.md`. Land if top-1 ≥ 85 %
  and top-3 ≥ 95 %; otherwise land the synonym table + recall change if they strictly improve both numbers, and record the gap.
  `lib/search/thresholds.ts` is regenerated by the eval, never hand-edited.

## 8. Gates that are measured, never lowered

- Phase 3 exit (Devin, phone): three packaged foods logged in under 5 s each from the + tap; one repeat scan in airplane mode.
- Phase 4 exit: per-method 10-item eval (`scripts/ai-eval.ts`, live model, outside CI) reports item accuracy, gram MAE and
  grounding auto-resolve precision ≥ 90 % **over auto-resolved items**. With today's thresholds (`0.95 / 0.30`) no query
  auto-resolves, so the precision figure may be vacuous; the runner must then print "0 auto-resolved of N" and the top-3
  containment rate instead, and the lane reports that, not a lowered threshold. Lane O is the intended fix.
- Security: cross-user denial on every new table and route; `authenticated` holds no write grant on `catalog_*`; a `mediaPath`
  under another uid is 403 and reads nothing; no module but `lib/server/catalog-writer.ts` imports the admin client to write `catalog_*`.

## 9. Integration stage (after K, L, M, N land; one terminal, branch `feat/p3-4-integration`)

1. Wire Today: `components/QuickActions.tsx` gains the Scan action (K's hand-off), the four capture actions (N's hand-off, disabled
   offline, hidden when the method is not enabled) above the existing water/gut/weight rows; `app/page.tsx` mounts
   `BarcodeScanSheet` → `ScanConfirmSheet`, `CaptureSheet`, `WaterCard` (and rewires `logWater()` to `lib/water-client.ts`);
   `components/LogFoodSheet.tsx` mounts `FavoritesStrip` at the top.
2. Supabase branch: migrations 20260919–20260921, `pnpm test:integration`, the Phase 3 and Phase 4 integration suites.
3. Canaries outside CI: iOS Safari `MediaRecorder` container → Gemini (spec Phase 4 open question 1; record the result in
   `docs/ai-data-handling.md`); `scripts/off-rate-probe.ts` (record the OFF per-IP limit in the Phase 3 spec's open question 1).
4. Vercel preview with `NEXT_PUBLIC_FEATURE_SCAN=1`, `CAPTURE_METHODS=text`, `NEXT_PUBLIC_CAPTURE_METHODS=text`; Devin's phone gates
   (Phase 3 manual gate; Phase 4 steps 1, 5, 6 for text). Then add `voice`, `label`, `photo` one deploy each with their evals.
5. `zs-land`; production flags follow Devin's sign-off, one method per deploy.

## 9a. Addenda landed 2026-09-11 (rulings record: `docs/decisions/2026-09-11-wave-3-4-rulings.md`)

- (a) `LogItemInput.confidence?: number` (0..1) in `lib/log/contract.ts`; `applyLogEntry` writes it to `log_items.confidence` (column exists) so the "check this" hint has data. Integration applies it.
- (b) `StructuredArgs.maxOutputTokens?: number` on `lib/ai/adapter.ts`, passed through to the provider call; defaults per purpose from `lib/ai/prompts.ts`.
- (c) `ProposeResponse.labelFood` is the label-method field (spec §5) — present only for `method: 'label'`; documented here so the client can rely on it.
- (d) **Commit re-runs the constraint policy.** `applyLogEntry` evaluates `evaluatePolicy` on every item (allergen tags from `catalog_ingredients` or `user_foods.allergen_tags`, the caller's `constraint_profiles`) and answers `{ status: "invalid", issues: [{ path: "items.<i>", message: "blocked:<reason>" }] }` for a `blocked` item — the sheet cannot be bypassed by a modified client. Fixtures for gluten, dairy and apple on the commit path are a release gate before any production capture flag.
- (e) Barcode negative cache: **no change — `NEGATIVE_CACHE_DAYS = 7` as shipped.** The earlier 48-hour conditional assumed `FDC_API_KEY` might stay unset; the key was obtained and wired on 2026-09-11, so that branch is dead code and is not to be written. The FDC Branded fallback is live in every environment.
- (f) Relevance gate AC8 stays OPEN at 83.6 / 100; `NEXT_PUBLIC_CATALOG_SEARCH=1` on the preview now, production after the phone check and the production catalog import; auto-resolve remains effectively off until top-1 ≥ 85 %.
- (g) Integration scope: bucket lock-down stays in the integration PR; the food-star affordance and the recipe "log one serving" fast path are a follow-up PR.
- (h) The sign-in code form accepts 6–8 digit codes (the project's `mailer_otp_length` is 8); `GET /api/dev/sign-in` (local only, 404 on Vercel) signs a dev server in as `DEV_SIGN_IN_EMAIL`.

## 10. Conventions

Phase 0 §8 and Phase 1–2 §8a apply. Add: provider text (OFF/FDC product names, ingredients, model output) is **data** — rendered as
text, passed to prompts only inside the `data` field, never interpolated into SQL or a prompt template; every Phase 4 prompt is
temperature 0 with a per-purpose `maxOutputTokens`; no draft is ever written to `log_entries` without a commit call; migrations
carry a matching `supabase/migrations/down/<name>.down.sql` that drops only what they created.
