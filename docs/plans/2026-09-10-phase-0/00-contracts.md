# Phase 0 — Shared contracts (frozen 2026-09-10)

Every lane codes against these names and signatures. A lane may add to its own files freely; it may
not rename anything here. If a contract must change, the change lands in this file first, in a commit
titled `docs: phase-0 contract change — <what>`, and every lane rebases on it.

Authority order: `docs/architecture.md` (v2.1) > `docs/specs/phase-0-foundations.md` > this file > lane plans.

## 1. Lanes and file ownership

| Lane | Owns (create/modify only these) | Branch |
|---|---|---|
| **A — Database** | `supabase/config.toml`, `supabase/migrations/20260911000100_catalog_shell.sql` … `…000600_rpc.sql`, `supabase/seed/`, `tests/rls/**`, `tests/helpers/supabase.ts`, `scripts/db-branch.sh`, `package.json` scripts `db:*` and `test:integration` (scripts block only) | `feat/p0-database` |
| **B — Auth + server boundary** | `lib/supabase/server.ts`, `lib/supabase/client.ts`, `lib/server/auth.ts`, `lib/server/admin.ts`, `lib/server/privileged.ts`, `lib/server/ratelimit.ts`, `lib/server/tokens.ts`, `lib/server/http.ts` (+ tests), `middleware.ts`, `app/auth/callback/route.ts`, `app/sign-in/page.tsx`, `components/AuthGate.tsx`, `app/api/mcp/route.ts` (auth swap only), `scripts/mint-token.ts`, `tests/mcp/**` | `feat/p0-auth` |
| **C — Sync engine** | `lib/sync/types.ts`, `lib/sync/keys.ts`, `lib/sync/merge.ts`, `lib/sync/fingerprint.ts`, `lib/sync/idb.ts`, `lib/sync/outbox.ts`, `lib/sync/client.ts` (+ tests), `app/api/sync/ops/route.ts`, `app/api/sync/changes/route.ts`, `components/SyncBootstrap.tsx`, `components/SyncStatus.tsx`, `tests/sync/**` (incl. `tests/sync/cross-user-http.test.ts`: user B → `/api/sync/ops` and `/api/sync/changes` against user A's data = 401/zero rows) | `feat/p0-sync` |
| **D — Data ops** | `lib/units.ts`, `lib/migrate/legacy.ts` (+ tests), `scripts/migrate-legacy.ts`, `supabase/migrations/20260911000700_legacy_backfill.sql`, `…000710_legacy_backfill_down.sql`, `…000800_drop_legacy.sql`, `lib/export/csv.ts`, `app/api/export/route.ts`, `app/api/jobs/backup/route.ts`, `scripts/backup.sh`, `scripts/restore-to-branch.sh`, `lib/ai/adapter.ts` (+ test), `scripts/ai-canary.ts`, `docs/ai-data-handling.md`, `tests/migrate/**`, `tests/export/cross-user.test.ts` (user B → `/api/export` = zero rows), `launchd/com.zs.smc-backup.plist`, `scripts/install-backup-timer.sh` | `feat/p0-data-ops` |
| **E — Theme (NeuForm restyle)** | `DESIGN.md`, `app/design-tokens.css`, `app/globals.css` (values only; legacy token names kept), `app/layout.tsx` (ground/body only), `app/page.tsx`, `app/foods/page.tsx`, `app/week/page.tsx`, `app/settings/page.tsx` (styling), `components/Ground.tsx` (delete), `components/MacroRings.tsx`, `SlotCard.tsx`, `TabBar.tsx`, `Sheet.tsx`, `QuickActions.tsx`, `Stepper.tsx`, `MyFoods.tsx`, `FoodsReference.tsx`, `LogFoodSheet.tsx`, `BuildMealSheet.tsx`, `AddFoodSheet.tsx`, `FoodSheet.tsx`, `SwapSheet.tsx`, `NoteSheet.tsx`, `LoggedExtras.tsx`, `ScaleWarning.tsx`, `RampControl.tsx`, `ShiftTimes.tsx`, `WeekGrid.tsx`, `InstallPrompt.tsx`, `ShareButton.tsx`, `IcsSubscribe.tsx`, `lib/gauge.ts` (+test), `public/manifest.webmanifest`, `public/icons/*`, `docs/screenshots/theme/*` | `feat/p0-theme` |

Shared files nobody edits on a lane branch: `package.json` dependencies (see §7 — installed once on `main` before lanes start), `AGENTS.md`, `docs/architecture.md`, `lib/store.ts`, `lib/types.ts`. Lanes B and C style their new screens (`sign-in`, `AuthGate`, `SyncStatus`) with the utility classes Lane E defines in `app/globals.css` (`.shell .surface .pill .pill-in .well .olive-panel`) and the token names already present today; they never add colours of their own. Lane E never renames or removes a token. Cut-over edits to `lib/store.ts` / `lib/sync.ts` / `lib/server/db.ts` deletion happen in the **integration branch** after all lanes merge (master plan, Stage 3).

## 2. Database contracts (Lane A produces; B, C, D consume)

Tables: exactly the DDL in `docs/architecture.md` §3.1–§3.7 and `docs/specs/phase-0-foundations.md` (Data changes), including `plan_days`, `user_settings`, `gut_log`, `api_tokens`, `health_sources` with `kind in ('apple_health_shortcut','health_auto_export','oura','manual')`.

RPCs (all `security definer`, `set search_path = public`, first argument `p_user_id uuid`, revoke execute from `anon`/`public`, grant to `authenticated` and `service_role` — **except `lookup_api_token`, which is `service_role` only** (contract change 2026-09-10, gap 8)):

```sql
-- returns the food_refs.id for (kind, id); creates the row if absent. kind ∈ 'catalog'|'user'.
create function get_or_create_food_ref(p_user_id uuid, p_kind text, p_catalog_food_id bigint, p_user_food_id uuid)
  returns uuid;

-- applies ONE sync op with compare-and-swap; appends change_log; returns the OpResult JSON (§3 below).
-- p_op is the SyncOp JSON. Runs in the caller's transaction (one op per call, one call per transaction).
create function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb;

-- change feed page: rows with seq > p_since, ascending, limit p_limit (≤ 500).
create function sync_changes(p_user_id uuid, p_since bigint, p_limit integer)
  returns table (seq bigint, entity text, entity_key text, rev integer, op text, at timestamptz, current jsonb);

-- sets revoked_at; returns true if a row changed.
create function revoke_api_token(p_user_id uuid, p_token_id uuid) returns boolean;

-- token lookup for the privileged boundary: returns null when missing/revoked/expired; bumps last_used_at.
create function lookup_api_token(p_token_hash bytea)
  returns table (id uuid, user_id uuid, scopes text[]);
```

`apply_sync_op` semantics (Lane A implements, Lane C tests through the route):
- `op.kind='create'`: insert; if `op_id` already in `change_log` → `{status:'duplicate'}`; if the row exists → treat as conflict with `current`.
- `'update'`/`'delete'`/`'restore'`: load row for `entity_key`; missing → `{status:'gone'}`; `deleted_at is not null` and kind ≠ 'restore' → `{status:'deleted', deleted_at}`; `base_rev ≠ rev` → `{status:'conflict', current_rev, current}`; else apply, `rev := rev + 1`, `seq := next_change_seq(p_user_id)`, insert `change_log(current := row_to_json after)`, return `{status:'applied', rev, seq}`.
- Child rows: `log_items` arrive inside `log_entries.payload.items[]` and are replaced wholesale on update; `current.items[]` is returned inline.
- Tombstone-capable entities: `user_foods`, `log_entries`, `gut_log` (they carry `deleted_at`). A `delete` or `restore` op on any other entity returns `{status:'unsupported'}` and writes nothing; `apply_sync_op` never raises for a client-shaped op. A `restore` on a row that is not tombstoned returns `{status:'applied', rev, seq}` **without** changing the row or appending to `change_log` (idempotent no-op).
- Any unexpected SQL error inside `apply_sync_op` is caught by the route, which appends `{op_id, status:'error', message}` for that op and **continues** with the next op; earlier results are always returned.
- `entity_key` for each entity: see §4.

Views (all `with (security_invoker = true)`, `grant select … to authenticated`): `weigh_ins` (architecture §2.1). No other view in Phase 0.

## 3. Sync wire types (Lane C owns the file; A, B, D import from it)

`lib/sync/types.ts` — exactly as in the spec (API changes): `Entity`, `SyncOp`, `OpResult`, `ChangeRow`, plus:

```ts
export const ENTITIES = ['user_foods','user_food_prefs','log_entries','water_log','plan_days',
  'user_settings','gut_log','duplicate_groups'] as const;   // log_items sync inside log_entries
export type OpsRequest  = { ops: SyncOp[] };                   // ≤ 200
export type OpsResponse = { results: OpResult[]; server_time: string };
export type ChangesResponse = { changes: ChangeRow[]; next_cursor: number; has_more: boolean };
```

## 4. Entity key encoding (Lane C owns `lib/sync/keys.ts`; Lane A's SQL must produce identical strings)

| Entity | `entity_key` | Row PK |
|---|---|---|
| `user_foods`, `log_entries`, `gut_log`, `duplicate_groups` | the UUID string, lowercase | `id` |
| `plan_days`, `water_log` | `YYYY-MM-DD` | `(user_id, local_date)` |
| `user_settings` | `'settings'` | `user_id` |
| `user_food_prefs` | `food_ref_id` UUID string (resolved 2026-09-10: `food_refs.id` is already unique across kinds, so architecture §3.7's older `<kind>:<id>` form is superseded) | `(user_id, food_ref_id)` |

```ts
export function encodeKey(entity: Entity, row: Record<string, unknown>): string;
export function decodeKey(entity: Entity, key: string): Record<string, unknown>; // returns the PK columns
```

### 4.1 Duplicate fingerprint (frozen bytes)
`sha256( local_date + '|' + slot + '|' + floor(epoch_seconds(eaten_at) / 900) + '|' + items )` where `items` is the
**comma-joined**, lexically sorted list of `canonical_food_id + ':' + (floor(grams / 5) * 5)`. Bucketing is **floor**, not round
(102 g and 104 g both → 100). Hex-encoded lowercase. A SQL implementation must produce the same bytes.

## 5. Auth and boundary helpers (Lane B produces; C, D consume)

```ts
// lib/supabase/server.ts
export function createRequestClient(req: Request): SupabaseClient;       // request-local, publishable key, cookies from req
// lib/server/auth.ts
export class HttpError extends Error { constructor(public status: number, public code: string, message?: string) }
export async function requireUser(req: Request): Promise<{ userId: string; client: SupabaseClient }>; // throws HttpError(401,'unauthorized')
// lib/server/admin.ts  — the ONLY file that reads SUPABASE_SERVICE_ROLE_KEY
export function adminClient(): SupabaseClient;
// lib/server/privileged.ts
export type TokenUser = { userId: string; tokenId: string; scopes: string[] };
export async function withTokenUser<T>(req: Request, scope: 'read' | 'log:write',
  fn: (ctx: TokenUser, admin: SupabaseClient) => Promise<T>): Promise<T>;   // HttpError 401 / 403
// lib/server/ratelimit.ts
export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void>; // HttpError(429,'rate_limited')
// lib/server/tokens.ts
export function hashToken(raw: string): Buffer;   // sha256
export function hasScope(scopes: string[], required: string): boolean;
export function mintToken(): { raw: string; hash: Buffer };  // 32 random bytes, base64url, prefix 'smc_'
// lib/server/http.ts (Lane B)
export function jsonError(e: unknown): Response;  // HttpError → {error: code, message}; anything else → 500 'internal'
export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes: number): Promise<T>; // 400 'bad_request' / 413 'too_large'
```

Env names (already in `.env.example`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SASHA_USER_ID`, `CRON_SECRET`, `GEMINI_API_KEY`, `NOUS_API_KEY`, `NOUS_BASE_URL`, `NOUS_COACH_MODEL_ID`, `AI_DAILY_SPEND_CAP_USD`, `CATALOG_IMPORT_DB_URL`.

## 6. Data-ops contracts (Lane D)

```ts
// lib/units.ts
export function gramsPerUnit(name: string, unit: FoodUnit): number | null;
export function perUnitTo100g(perUnit: Food['perUnit'], gramsPerUnit: number): Record<string, number>; // keys: protein_g, carbohydrate_g, fat_g, energy_kcal (Atwater)
// lib/export/csv.ts
export function escapeCell(value: unknown): string;
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string;
// lib/ai/adapter.ts
export const MODELS = { textToItems: 'gemini-3.8-flash', voiceToItems: 'gemini-3.8-flash',
  labelToNutrients: 'gemini-3.8-flash', photoToItems: 'gemini-3.8-flash',
  coach: 'anthropic/claude-sonnet-5', weeklyReview: 'anthropic/claude-opus-5' } as const;
export function assertPinnedSdk(): void;
export async function generateStructured<T>(args: { purpose: string; userId: string;
  schema: ZodType<T>; parts: Part[]; admin: SupabaseClient }): Promise<T>;
// Spend cap: before every call, sum ai_calls.cost_estimate for (userId, today in UTC); if ≥ AI_DAILY_SPEND_CAP_USD
// throw HttpError(429, 'spend_cap'). Cost is estimated from token counts × a per-model price table in the adapter.
```

## 7. Pre-lane setup on `main` (done once, before any lane branches)

```bash
pnpm add @supabase/ssr idb @google/genai      # installed 2026-09-10: @supabase/ssr 0.12.x, idb 8.x, @google/genai 2.21.x
pnpm add -D supabase fake-indexeddb tsx       # supabase CLI 2.117.x; fake-indexeddb for idb tests; tsx runs scripts/*.ts with `@/` aliases
```
Pinned SDK major for `assertPinnedSdk()`: **`@google/genai` major = 2** (correction: the spec said 1 before install).
JSON Schema for Gemini `responseSchema` comes from Zod 4's built-in `z.toJSONSchema(schema)`; do not add
`zod-to-json-schema`.
Node 22, pnpm 11.25.0, Next 16.3.4, vitest 5. Unit tests: `pnpm test <file>`. Integration tests: `pnpm test:integration` (Lane A defines; needs `SUPABASE_TEST_URL` + `SUPABASE_TEST_SERVICE_ROLE_KEY` of a Supabase branch, skipped when unset).

Scripts run as `pnpm exec tsx scripts/<name>.ts` (tsx resolves the `@/` tsconfig alias). Node's `--experimental-strip-types`
with relative `.ts` imports is also acceptable; both are installed on `main`.

## 8. Conventions every lane follows

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full suite twice.
