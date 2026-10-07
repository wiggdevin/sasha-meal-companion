# Phase 0 — Foundations

Spec for the Phase 0 row of `docs/architecture.md` §8. Architecture v2.1 is the authority; this
file names files, types and gates. Where a section number appears (§2.1, §3.7) read that section
there rather than here. Numbers stay owned by `../../analysis/targets.md`.

## Goal

Put a real identity under the app — Supabase Auth, a privileged server boundary for token clients,
and the v2.1 user schema as shadow tables — then move Sasha's data off the single-tenant jsonb
store and delete the legacy route in the same release. Phase 0 adds no user-visible feature: her
list, her plan and her ticks must look identical after the cut-over.

## Scope

**In.** Supabase Auth (email OTP) and the request-local server client (§2.1). Privileged server
boundary and `api_tokens` (§2.2). The §3.2–3.4 and §3.6 user tables plus the §3.1 catalog DDL as
empty shells so foreign keys resolve. Entity sync: outbox, compare-and-swap, `change_log` cursor
(§3.7). Legacy backfill with count checks, a tested rollback, then deletion of `foods` / `days` /
`settings` and `/api/sync` (§2.3). `GET /api/export` (§4.6) and a nightly database backup. The §5
matrix rows listed under Security. `lib/ai/adapter.ts` pinned, with the Gemini paid-tier check and
the Nous canary (§6).

**Out.** Catalog import and search (Phase 1). Grams, snapshots, `daily_totals` (Phase 2). Barcode,
recipes, favorites UI (Phase 3). Media and AI capture (Phase 4). Health ingest and Oura (Phase 5).
Estimator and proposals (Phase 6). Coach (Phase 7). Duplicate-group UI — the tables and the
fingerprint function ship here, the card ships with Phase 2 logging.

**Additions to v2.1 this phase makes.** §3 defines no home for plan state, gut check-ins or a
manually typed weight, and the cut-over deletes the jsonb that holds them today. Phase 0 adds
`plan_days`, `user_settings` and `gut_log` (SQL below) and adds `'manual'` to the
`health_sources.kind` check so a typed weigh-in has a source row. Devin signs these off before the
backfill runs.

## User stories

- **Sasha** opens her install link, types her email, taps the magic link, and sees the same foods,
  the same ticks and the same targets she had before. She never sees a token again.
- **Sasha** ticks a meal in airplane mode on the phone, opens the app on the laptop an hour later,
  and both devices agree without losing either edit.
- **Devin** runs one command and gets a dated backup of her whole account, and a second command
  that restores it into a Supabase branch.
- **Devin** rolls the cut-over back inside ten minutes if the row counts do not match.
- **An agent over MCP** presents a personal access token, reads and writes only Sasha's rows, and
  is refused with 401 when the token is revoked and 403 when it lacks the `log:write` scope.

## Data changes

Migrations live in `supabase/migrations/`, applied to a Supabase branch first (Rollout below).

| File | Contents |
|---|---|
| `20260911000100_catalog_shell.sql` | §3.1 DDL exactly as written, no rows. Phase 1 fills it. |
| `20260911000200_user_schema.sql` | §3.2, §3.3, §3.4, §3.6 tables; `plan_days`, `user_settings`, `gut_log` below. |
| `20260911000300_sync.sql` | §3.7 `change_seq`, `change_log`, `next_change_seq`, `duplicate_groups`, `duplicate_group_members`. |
| `20260911000400_privileged.sql` | §2.2 `api_tokens`; `health_sources` with `'manual'` added to the kind check. |
| `20260911000500_rls.sql` | `enable row level security` plus the §2.1 policy pair on every user table; `grant select` on views. |
| `20260911000600_rpc.sql` | `get_or_create_food_ref`, `apply_sync_op`, `revoke_api_token`, all `security definer` with `p_user_id` first. |
| `20260911000700_legacy_backfill.sql` | Copies legacy rows into the new tables; ends with count assertions that `raise exception` on mismatch. |
| `20260911000710_legacy_backfill_down.sql` | Truncates the backfilled rows only. Legacy tables are untouched until the next migration. |
| `20260911000800_drop_legacy.sql` | `drop table foods, days, settings`. Runs in the cut-over release, after the manual gate. |

The three tables v2.1 does not define:

```sql
create table plan_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  day_type_override text check (day_type_override in ('training-10','training-7-fasted','rest')),
  floor_day boolean not null default false,
  swaps jsonb not null default '{}'::jsonb,          -- {slot_id: meal_id}
  slot_notes jsonb not null default '{}'::jsonb,     -- {slot_id: text}
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, local_date));

create table user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_opened_at timestamptz not null,
  scale_warning_dismissed boolean not null default false,
  training_kcal integer, rest_kcal integer, protein_g numeric,   -- null = follow the ramp
  protein_locked boolean not null default true,
  ramp_override smallint check (ramp_override between 1 and 3),
  slot_times jsonb not null default '{}'::jsonb,
  shift_minutes integer not null default 0,
  changed_at timestamptz, rev integer not null default 1);

create table gut_log (
  id uuid primary key,                               -- client-generated
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null, tz text not null,
  state text not null check (state in ('good','iffy','flare')),
  note text, rev integer not null default 1, deleted_at timestamptz,
  unique (user_id, local_date));
```

Every table above, and every §3.2–3.6 table, carries the same policy pair. `plan_days` shown as the
pattern; the migration repeats it per table rather than looping:

```sql
alter table plan_days enable row level security;
create policy plan_days_rw on plan_days for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

Three table shapes need three policy patterns; the migration uses the right one per table:

1. **Owner tables** (`user_id` column): the pair above.
2. **Child tables without `user_id`** (`log_items`, `recipe_items`, `favorites_*` items): a parent-existence
   policy, so a child is visible and writable only when its parent row is the caller's:
   ```sql
   alter table log_items enable row level security;
   create policy log_items_rw on log_items for all to authenticated
     using  (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())))
     with check (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())));
   ```
3. **Shared reference tables** (`food_refs`, every `catalog_*`): RLS enabled, `select` granted to
   `authenticated` with `using (true)`, no insert/update/delete policy for users (the import worker writes
   with the admin client). `food_refs` rows of `kind='user'` are additionally filtered through the join to
   `user_foods.user_id`, so another user's custom food never appears in search.

**Backfill mapping**, run by `scripts/migrate-legacy.ts` against one `SASHA_USER_ID`:

| Legacy | Target |
|---|---|
| `foods.data` (`Food`, per-unit macros) | `user_foods` (`kind='custom'`) + `food_refs` (`kind='user'`) + `user_food_prefs` (`status`, `role`, `no_cook`, `note`) |
| `days.data.extras` (`LoggedFood`) | one `log_entries` row per entry (`method` from the entry, `slot` from its time) + `log_items` |
| `days.data.eaten` (slot ticks) | `log_entries` with `method='plan'`, `slot` = the `SlotId`, `eaten_at` = the stored timestamp |
| `days.data.waterMl` | `water_log.cups` = `round(waterMl / 240)` |
| `days.data.weightLb` | `health_samples` `type='body_mass'`, `unit='lb'`, via a `health_sources` row `kind='manual'` |
| `days.data.gut` | `gut_log` |
| `days.data.floorDay`, `dayTypeOverride`, `swaps`, `notes` | `plan_days` |
| `settings.data` | `user_settings` |

`user_foods.per_100g` needs a gram weight per legacy unit. `lib/units.ts` (new, pure) resolves
`unit` → grams using the household portions already in `lib/food-db.ts`. A food whose unit does not
resolve is written to `docs/migration-unresolved.csv` and the backfill **refuses to run** until
Devin resolves every row. Count checks: `user_foods` = legacy `foods`; `log_entries` = extras plus
ticks; `plan_days` = touched days; any mismatch raises and rolls the transaction back.

## API changes

New and changed files under `app/api/`. All bodies are validated with zod; a parse failure is 400
with `{error:'bad_request', detail}` and never echoes the body.

```ts
// lib/sync/types.ts
export type Entity = 'user_foods' | 'user_food_prefs' | 'log_entries' | 'log_items'
  | 'water_log' | 'plan_days' | 'user_settings' | 'gut_log' | 'duplicate_groups';
export type SyncOp = {
  op_id: string; entity: Entity; entity_id: string;
  kind: 'create' | 'update' | 'delete' | 'restore';
  base_rev: number | null; payload: Record<string, unknown>; client_ts: string;
};
export type OpResult =
  | { op_id: string; status: 'applied'; rev: number; seq: number }
  | { op_id: string; status: 'conflict'; entity: Entity; current_rev: number; current: unknown }
  | { op_id: string; status: 'deleted'; entity: Entity; deleted_at: string }
  | { op_id: string; status: 'gone' | 'duplicate' };
export type ChangeRow = { seq: number; entity: Entity; entity_key: string; rev: number;
  op: SyncOp['kind']; at: string;
  current: Record<string, unknown> | null };   // row after the op, children inline; null = deleted
// `entity_key` is the text key encoding from architecture §3.7 (`lib/sync/keys.ts`), so
// date-keyed and composite-keyed entities sync the same way as UUID-keyed ones.
```

| Route | Method | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| `app/api/sync/ops/route.ts` | POST | JWT | `{ ops: SyncOp[] }`, ≤ 200 ops | `{ results: OpResult[]; server_time: string }` | 401 no session · 400 bad shape · 413 over 1 MB · 429 over 60/min |
| `app/api/sync/changes/route.ts` | GET | JWT | `?since=<seq>&limit=<≤500>` | `{ changes: ChangeRow[]; next_cursor: number; has_more: boolean }` | 401 · 400 non-numeric `since` · 429 |
| `app/api/export/route.ts` | GET | JWT | `?kind=meals\|progress\|recipes\|favorites\|water&format=csv\|json&page=` | CSV or `{ rows, next_page }` | 401 · 400 unknown `kind` · 429 over 10/hour |
| `app/api/mcp/route.ts` | POST | `api_tokens` bearer | unchanged tool surface | unchanged | 401 unknown/revoked/expired · 403 missing scope · 429 |
| `app/auth/callback/route.ts` | GET | none | `?code=&next=` | 302 to `next` (same-origin only) | 400 missing code · 302 to `/sign-in?error=` on exchange failure |
| `app/api/jobs/backup/route.ts` | POST | `Bearer $CRON_SECRET` | — | `{ ok: true; bytes: number }` | 401 · 409 a run already holds the lock |
| `app/api/sync/route.ts` | — | — | **deleted** in the cut-over release | — | — |

`app/api/sync/ops/route.ts` is a thin handler: identity from `requireUser()`, then one
`apply_sync_op` RPC per op inside one transaction per op, in array order. An op whose `op_id` is
already in `change_log` returns `status:'duplicate'` without re-applying.

Supporting server modules:

- `lib/supabase/server.ts` — request-local `createServerClient` (`@supabase/ssr`, publishable key,
  caller's cookies). Never module-cached. §2.1.
- `lib/supabase/client.ts` — browser client for the sign-in screen.
- `lib/server/auth.ts` — `requireUser(req): Promise<{ userId: string }>`, identity from
  `getClaims()`. Throws a typed 401.
- `lib/server/admin.ts` — the only module holding `SUPABASE_SERVICE_ROLE_KEY`. §2.2 rule 4.
- `lib/server/privileged.ts` — `withTokenUser(req, scope, fn)`. Hashes the bearer, looks it up,
  refuses a callback that does not receive a `user_id`. §2.2 rules 1–3, 5.
- `lib/server/ratelimit.ts` — fixed-window counter keyed by user or token id.
- `middleware.ts` — refreshes the Supabase session cookie; redirects an unauthenticated page
  request to `/sign-in`.
- `lib/server/db.ts` — **deleted** with the legacy route.

## Client changes

- `app/sign-in/page.tsx` — one email field, one button, then "check your email". Glass card on the
  existing ground; 26px radius, 44px targets, no new palette.
- `components/AuthGate.tsx` — wraps the tab shell. A signed-out user sees the sign-in screen; a
  signed-in user sees no change. Reads from IndexedDB and renders before the session check
  resolves, so a cold offline open still shows today.
- `components/SyncBootstrap.tsx` — rewritten: pull `changes` since the stored cursor, apply, drain
  the outbox, resolve conflicts with `lib/sync/merge.ts`. Same triggers as today (open, return,
  reconnect, 1.5 s after a local save). The `#k=` token path and `lib/sync.ts` are deleted.
- `components/SyncStatus.tsx` — shows the signed-in email, pending-op count, last sync, and a
  "signed out" state. Replaces the token wording in Settings.
- `lib/sync/idb.ts` — `idb` store mirroring the user tables plus the outbox
  (`{op_id, entity, entity_id, kind, base_rev, payload, client_ts}`). `lib/store.ts` keeps writing
  localStorage until the cut-over, then reads through IndexedDB.
- Offline behaviour is unchanged in feel: the local write lands first, the op queues, and a failed
  push retries with backoff. A conflict is merged silently except `target_profiles`, which shows
  "targets changed elsewhere".

## Engines and logic

Pure, no I/O, unit-tested.

```ts
// lib/sync/merge.ts — §3.7 per-entity merge rules
export function mergeEntity<E extends Entity>(
  entity: E, local: Row<E>, server: Row<E>, localTs: string, serverTs: string): Row<E>;
export function rebaseOp(op: SyncOp, merged: unknown, currentRev: number): SyncOp;

// lib/sync/fingerprint.ts — §3.7 duplicate fingerprint
export function entryFingerprint(input: {
  localDate: string; slot: string; eatenAt: string;
  items: { canonicalFoodId: string; grams: number }[] }): string;

// lib/units.ts — legacy unit → grams, for the backfill and for per_100g
export function gramsPerUnit(name: string, unit: FoodUnit): number | null;
export function perUnitTo100g(perUnit: Food['perUnit'], gramsPerUnit: number)
  : Record<string, number>;

// lib/server/tokens.ts
export function hashToken(raw: string): Buffer;                  // sha256
export function hasScope(scopes: string[], required: string): boolean;

// lib/export/csv.ts — §4.6
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string;
export function escapeCell(value: unknown): string;              // prefixes = + - @ with '

// lib/ai/adapter.ts — §6
export const MODELS = { textToItems: 'gemini-3.8-flash', /* … */ } as const;
export function assertPinnedSdk(): void;      // reads the installed @google/genai major
export async function generateStructured<T>(args: {
  purpose: string; userId: string; schema: ZodType<T>; parts: Part[] }): Promise<T>;
```

`generateStructured` writes one `ai_calls` row per call with `model_id` and `sdk_version`, retries
twice with backoff, and opens the circuit at 5 failures in 10 minutes.

## Security

Rows this phase adds to the §5 matrix, enforced in code and asserted by tests:

| Route | Identity | Body limit | Rate limit | Idempotency |
|---|---|---|---|---|
| `/api/sync/ops`, `/api/sync/changes` | Supabase JWT, RLS (§2.1) | 1 MB | 60/min/user | `op_id` |
| `/api/export` | JWT, user-scoped read | 16 KB | 10/hour/user | — |
| `/api/mcp` | `api_tokens` hash, privileged boundary (§2.2) | 64 KB | 60/min/token | `op_id` |
| `/api/jobs/backup` | `Bearer $CRON_SECRET` | — | — | per-day lock |
| `/api/sync` (legacy) | `SASHA_SYNC_TOKEN` + `SASHA_USER_ID` match | 1 MB | 60/min | — · deleted at cut-over |
| `/auth/callback` | none; `code` exchange, same-origin `next` only | 1 KB | 20/min/IP | — |

Additional rules: every view is created `with (security_invoker = true)` and granted to
`authenticated`; `user_id` never comes from a request body; the service-role key appears in
`lib/server/admin.ts` and nowhere else, asserted by a repo-wide grep test; MCP tokens are shown once
at creation and stored only as a hash.

## Test plan

**Unit** (`pnpm test <file>`): `lib/sync/merge.test.ts` — every row of the §3.7 merge table,
including water taking the larger value and notes keeping both. `lib/sync/fingerprint.test.ts` —
device order does not change the fingerprint; two coffees 20 minutes apart differ. `lib/units.test.ts`
— every unit in the current seed resolves. `lib/server/tokens.test.ts` — hash, revoked, expired,
scope. `lib/export/csv.test.ts` — a cell starting `=` is prefixed. `lib/ai/adapter.test.ts` — model
IDs are literals with no "latest" alias, and the installed `@google/genai` major is 2 (2.21.x installed 2026-09-10).
`lib/migrate/legacy.test.ts` — mapping over a fixture store, and a refusal on an unresolved unit.

**Integration** (`tests/`, against a Supabase branch, not CI-gated on production):
`tests/rls/cross-user.test.ts` — a second user reads zero rows from every table, view, function,
route and export. `tests/rls/security-invoker.test.ts` — every view reports `security_invoker=on`.
`tests/mcp/token.test.ts` — a token for user A cannot reach user B through any tool. `tests/sync/cross-user-http.test.ts` and `tests/export/cross-user.test.ts` — user B gets 401 or zero rows from `/api/sync/ops`, `/api/sync/changes`, `/api/export` against user A's data.
`tests/sync/two-client.test.ts` — the concurrent add/edit/delete matrix, a rejected stale update, a
stale delete that does not erase a newer edit, the restore path, offline replay, an idempotent
retry, and cursor continuity under interleaved writes. `tests/migrate/rollback.test.ts` — backfill,
assert counts, run the down migration, assert the legacy tables are intact.

**Manual gate (Devin, on the phone).** Sign Sasha in with the magic link on the real device; her
food list, today's ticks and her targets are unchanged. Turn on airplane mode, tick a meal, add a
food, reopen the app — both survive. Turn signal back on, open the laptop, confirm both appear.
Revoke the MCP token from `api_tokens` and confirm Codex gets 401. Confirm the old `#k=` link no
longer signs anything in.

## Acceptance criteria

1. `pnpm test`, `pnpm lint` and `pnpm build` are green on the branch.
2. Sasha signs in with an email OTP and stays signed in across a cold app launch.
3. No route handler holds a module-level Supabase client; a test asserts the client is constructed
   per request.
4. `tests/rls/cross-user.test.ts` passes for every table, view, function, route and export.
5. Every view returns `security_invoker=on`.
6. `SUPABASE_SERVICE_ROLE_KEY` appears in exactly one source file.
7. An MCP call with a revoked token returns 401; one missing `log:write` returns 403; one for
   another user's data returns zero rows.
8. A stale op returns `status:'conflict'` with the full current entity and writes nothing.
9. A tombstoned entity is never resurrected by a stale update; only an explicit `restore` revives it.
10. `GET /api/sync/changes` returns contiguous, ascending `seq` values under interleaved writes from
    two clients plus MCP; no client skips a change.
11. The backfill's count assertions pass, and the down migration restores the pre-backfill state.
12. `GET /api/export?kind=meals&format=csv` returns her data with `tz` and `local_date`, and every
    cell starting `= + - @` is prefixed with `'`.
13. Backup is two-part: `POST /api/jobs/backup` (Vercel cron) writes a dated JSON dump of the user tables to the private
    Storage bucket `backups`; `scripts/backup.sh`, scheduled by launchd `com.zs.smc-backup` nightly on the Mac, writes a
    `supabase db dump` to `~/Backups/supabase/meal-companion/` and keeps the last 14.
14. `pnpm ai:canary` (`scripts/ai-canary.ts`, run outside CI before release A) exits non-zero when the Gemini key resolves
    to an unpaid project or when `@google/genai` is not major 2; `docs/ai-data-handling.md` records the run.
15. `docs/ai-data-handling.md` exists and records the Gemini settings verified, with a date, and the
    Nous Portal retention answer from the canary.
16. After the cut-over release, `foods`, `days`, `settings` and `app/api/sync/route.ts` are gone,
    and `rg SASHA_SYNC_TOKEN` returns nothing.

## Rollout and rollback

1. Create a Supabase branch off `fivatgdpuenszxxnijpc`. Apply migrations `…000100`–`…000600`.
   Run the integration suites there.
2. Take a full backup of production (`POST /api/jobs/backup`) and verify it restores into the
   branch. This is the rollback artefact.
3. Merge the branch. Deploy release **A**: auth, shadow tables, new sync routes, export, adapter.
   `/api/sync` and the jsonb tables still serve the phone. Both paths are live; nothing is deleted.
4. Sasha signs in. Devin runs the manual gate on release A.
5. Run `…000700_legacy_backfill.sql` with `scripts/migrate-legacy.ts`. Count assertions gate it.
   Devin re-runs the manual gate against the migrated data.
6. Deploy release **B** (cut-over): client reads the new tables, `…000800_drop_legacy.sql` runs,
   `/api/sync`, `lib/sync.ts` and `lib/server/db.ts` are deleted.

**Rollback.** Before step 5, revert the Vercel deployment — the legacy tables are untouched. After
step 5 and before step 6, run `…000710_legacy_backfill_down.sql`; it truncates only backfilled rows.
After step 6, restore the step-2 backup into a branch, promote it, and redeploy release A. The
deletion in step 6 is the point of no cheap return, which is why it is a separate release behind a
manual gate.

## Open questions

1. `plan_days`, `user_settings`, `gut_log` and `health_sources.kind='manual'` extend v2.1 §3. Devin
   approves the shape, or names where else plan state, gut check-ins and a typed weight should live.
2. Legacy `Food.perUnit` is per household unit, not per 100 g. `lib/units.ts` resolves most units;
   the unresolved list needs Devin's gram weights before the backfill can run.
3. Email OTP needs a sender. Supabase's built-in SMTP is rate-limited and not for production —
   confirm whether to wire a custom SMTP sender in Phase 0 or accept the built-in limit for one user.
4. `SASHA_USER_ID` must be the `auth.users` id created by her first sign-in, so step 5 cannot run
   before step 4. Confirm that ordering is acceptable, or pre-create the user by invite.
5. Nous Portal retention and data-use terms are still unconfirmed (§10). Until the canary answers,
   Gemini serves every call and Nous is not a dependency.
6. Does Phase 0 keep the `.ics` subscription and the share summary unchanged? Both read
   `lib/store.ts`, which the cut-over rewires to IndexedDB.
