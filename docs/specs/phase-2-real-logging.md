# Phase 2 — Real logging: grams, nutrient snapshots, Today, CSV export

Spec of record for Phase 2, covering **F-058 … F-061** (`docs/features.md`). Authority is
`docs/architecture.md` v2.1; numbers are owned by `../analysis/targets.md`. Assumes Phase 0 (auth,
user schema, CAS sync, legacy cut-over) and Phase 1 (catalog import, search) have shipped.

## Goal

Every logged item carries real grams and a frozen nutrient snapshot, so the Today screen reports
calories, macros, fiber and micronutrient coverage from measured values instead of authored meal
estimates. Her whole log leaves the app as CSV that opens cleanly in a spreadsheet.

## Scope

**In.** Grams-first logging into `log_entries` / `log_items`; the server-computed snapshot
(`compute_item_snapshot`, §3.3); `daily_totals` with per-nutrient coverage; Today showing kcal,
macros, fiber and micro coverage; a per-entry nutrient breakdown; DRI rows for the tracked micro set;
`GET /api/export` for `kind=meals|progress`; `POST /api/log/commit`; MCP `get_day` on real nutrients.

**Built since (2026-10-08): the duplicate-entry card.** `components/today/DuplicateEntryCard.tsx`
(mounted on Today between the Day card and the meal list) shows one "Logged twice?" card per open
`duplicate_groups` row of the viewed day, with the two entries (time, foods, kcal), **Keep both**
(→ `dismissed`, with Undo) and **Merge** (the newer entries go through the normal delete path; the
group becomes `merged` into the oldest, whose items are untouched; no Undo, a delete is a tombstone).
`lib/duplicates/read.ts` reads the group from the sync mirror and finds its members by recomputing
the shared fingerprint over the mirrored entries; `lib/duplicates/actions.ts` writes each decision
as a `duplicate_groups` update through the outbox. **Server gap:** `recordFingerprint`
(`lib/server/log-duplicates.ts`) inserts the group directly and writes no `change_log` row, so a
group never reaches the phone's change feed; until it does, the card stays hidden in production.

**Out.** Barcode, recipes, favorites, water UI and the export kinds `recipes`, `favorites`, `water`
(Phase 3+). No phase currently owns an `exercise` export kind or an exercise-logging table — see Open
question 5. AI capture and the propose/confirm sheet (Phase 4) — `/api/log/commit` ships here,
but its only Phase 2 callers are the log sheet and the sync applier. Weight, sleep, steps (Phase 5).
TDEE and percent targets (Phase 6). Coach (Phase 7). Changes to the ramp, slot times or meal library.

## User stories

- **Sasha.** She logs 140 g of chicken thigh with no signal and sees calories and protein land on Today
  at once. The entry shows iron and potassium, with a dash where the source measured nothing. Today
  reads 18 g of fiber against her 20–25 g band, and 7 of 12 tracked micronutrients with data.
- **Devin.** `/api/export?kind=meals&format=csv` gives him one row per logged item with grams, source
  and source version, for the fdc.nal.usda.gov check; `kind=progress` gives daily totals against target.
- **Agent via MCP.** `get_day` returns the totals the phone shows — kcal, macros, fiber, coverage —
  through the privileged boundary (§2.2), never a client key.

## Data changes

Tables come from Phase 0 (`log_entries`, `log_items`, `food_refs`, `user_foods`) and Phase 1
(`catalog_*`). Phase 2 adds **no new table** — one function, one view, one privileged RPC, one seed,
two indexes and one policy repair, in this order:

### `supabase/migrations/20260918090000_phase2_log_item_guards.sql`

`log_items` has no `user_id`, so the §2.1 policy pair binds through its parent entry. The migration
drops by name first, so it is a no-op where Phase 0 already shipped the policy.

```sql
alter table log_items enable row level security;
drop policy if exists log_items_rw on log_items;
create policy log_items_rw on log_items for all to authenticated
  using (exists (select 1 from log_entries le
                  where le.id = log_items.entry_id and le.user_id = (select auth.uid())))
  with check (exists (select 1 from log_entries le
                  where le.id = log_items.entry_id and le.user_id = (select auth.uid())));
create index if not exists log_items_entry on log_items (entry_id);
create index if not exists log_entries_export on log_entries (user_id, local_date, eaten_at, id);
```

### `supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql`

`amount` is the **item's contribution** in the nutrient's own unit, grams already applied; `basis`
records the per-100 g source, so a grams edit recomputes the snapshot. `null` means the source did not
measure the nutrient; `0` means it measured zero (§3.3).

```sql
create or replace function compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
returns jsonb language sql stable as $$
  with ref as (select * from food_refs where id = p_food_ref_id),
  rev as (select r.id, v.source, v.version_label from catalog_food_revisions r
            join catalog_versions v on v.id = r.catalog_version_id
            join ref on ref.catalog_food_id = r.catalog_food_id where r.is_active),
  catalog_vals as (select n.nutrient_code as code, n.amount_per_100g as per100, c.unit,
           rev.source, rev.version_label, rev.id as revision_id from rev
      join catalog_food_nutrients n on n.food_revision_id = rev.id
      join catalog_nutrients c on c.code = n.nutrient_code),
  user_vals as (select kv.key as code, nullif(kv.value, 'null'::jsonb)::numeric as per100, c.unit,
           'user'::text as source, uf.rev::text as version_label, null::bigint as revision_id
      from ref join user_foods uf on uf.id = ref.user_food_id
      cross join lateral jsonb_each(uf.per_100g) kv join catalog_nutrients c on c.code = kv.key),
  vals as (select * from catalog_vals union all select * from user_vals)
  select coalesce(jsonb_object_agg(code, jsonb_build_object(
           'amount', case when per100 is null then null else round(per100*p_grams/100.0, 4) end,
           'unit', unit, 'basis', 'per_100g', 'source', source,
           'source_version', version_label, 'revision_id', revision_id)), '{}'::jsonb) from vals;
$$;
grant execute on function compute_item_snapshot(uuid, numeric) to authenticated;
```

### `supabase/migrations/20260918090200_phase2_daily_totals.sql`

One row per user, local date and nutrient code. Coverage is **items carrying a value ÷ all items that
day** (§3.3), so a partial day never reads as a complete one.

```sql
create view daily_totals with (security_invoker = true) as
with item_nutrients as (
  select le.user_id, le.local_date, kv.key as code, (kv.value->>'amount')::numeric as amount
    from log_entries le join log_items li on li.entry_id = le.id
    cross join lateral jsonb_each(li.snapshot) kv where le.deleted_at is null),
day_items as (
  select le.user_id, le.local_date, count(*)::int as items_total
    from log_entries le join log_items li on li.entry_id = le.id
   where le.deleted_at is null group by 1, 2)
select n.user_id, n.local_date, n.code as nutrient_code, sum(n.amount) as amount,
       count(n.amount)::int as items_with_value, d.items_total,
       round(count(n.amount)::numeric / nullif(d.items_total, 0), 4) as coverage
  from item_nutrients n
  join day_items d on d.user_id = n.user_id and d.local_date = n.local_date
 group by n.user_id, n.local_date, n.code, d.items_total;
grant select on daily_totals to authenticated;

-- Privileged boundary only (§2.2 rule 3): user-scoped, never granted to authenticated.
create or replace function get_daily_totals(p_user_id uuid, p_local_date date)
returns table (nutrient_code text, amount numeric, items_with_value int,
               items_total int, coverage numeric)
language sql security definer set search_path = public, pg_temp as $$
  select nutrient_code, amount, items_with_value, items_total, coverage
    from daily_totals where user_id = p_user_id and local_date = p_local_date;
$$;
revoke execute on function get_daily_totals(uuid, date) from public, authenticated, anon;
```

`daily_totals` is `security_invoker`, so a browser session sees only its own rows. `get_daily_totals`
is `security definer` on purpose: the MCP boundary has no `auth.uid()` and binds the tenant with
`p_user_id`.

### `supabase/migrations/20260918090300_phase2_catalog_dri_seed.sql`

Reference values for the micro list, female 19–30, NASEM DRI tables. Twelve rows in one shape:

```sql
insert into catalog_dri (nutrient_code, authority, ref_type, sex, age_min, age_max,
                         life_stage, value, unit, effective_date) values
  ('fiber_total','NASEM','AI','female',19,30,'none',25,'g','2005-01-01'),
  ('iron','NASEM','RDA','female',19,30,'none',18,'mg','2001-01-01')
  -- then calcium 1000 mg · potassium 2600 mg (AI) · magnesium 310 mg · zinc 8 mg · vitamin_c 75 mg
  -- · vitamin_d 15 µg · vitamin_b12 2.4 µg · folate_dfe 400 µg · vitamin_a_rae 700 µg · sodium 1500 mg (AI)
on conflict do nothing;
```

**Fiber is not shown against the DRI.** `targets.md` sets her band at **20–25 g/day,
soluble-dominant** ("do not chase fibre to hit carbs"), below the 25 g AI. The band wins on her
screen; the DRI row exists for export and for later users.

## API changes

Two routes, both already in the §5 matrix; no route outside it is added.

### `POST /api/log/commit` — JWT, 64 KB, 60/min/user, idempotent on `entry_id`

**This is the one canonical `LogCommitRequest` for the route** — the type below supersedes
`phase-4-ai-capture.md`'s separate `CommitRequest`, which used camelCase field names
(`entryId`, `localDate`, `eatenAt`) and dropped `method` and `base_rev` entirely. Every field in
`log_entries` (§3.3) is named in snake_case on the wire already — `entry_id`, `local_date`, `base_rev`
and the Phase 0 sync envelope (`lib/sync/types.ts`) all agree on that casing — so snake_case is the
convention this contract keeps, and Phase 4's commit calls travel the same route with the same shape:

```ts
// lib/log/contract.ts — shared by client and server, zod-validated on the server
export type LogItemInput = { id: string; seq: number; food_ref_id: string;
  qty: number; unit: string; grams: number;           // grams >= 0
  portion_id?: number | null; food_revision_id?: number | null; was_edited?: boolean };
export type LogCommitRequest = {                      // base_rev absent = create
  entry_id: string; base_rev?: number;                // entry_id is a client-generated uuid
  eaten_at: string; tz: string; local_date: string; slot: SlotId;
  method: "search" | "plan" | "text" | "voice" | "label" | "photo";  // full set, §3.3;
                                                       // Phase 2's own callers send only search|plan|text
  draft_id?: string;              // set when this commit resolves a Phase 4 propose() draft;
                                   // required when method is voice | label | photo
  save_label_as_food?: boolean;   // method: "label" only — writes a user_foods row, kind='label_scan'
  note?: string; items: LogItemInput[] };  // 1..30 items
export type LogCommitResponse = { status: "ok"; entry_id: string; rev: number;
  user_food_id?: string;                                        // set when save_label_as_food created one
  items: { id: string; grams: number; snapshot: Snapshot }[];   // server snapshot wins
  totals: DayTotals };                                          // the day after this write
export type LogCommitFailure =                      // 409 unless noted
  | { status: "conflict"; current_rev: number; entity: LogEntry }   // full entity (§3.7)
  | { status: "deleted"; deleted_at: string }                       // tombstone dominates
  | { status: "gone" }                                              // 410, unknown entry on update
  | { status: "stale_revision"; food_ref_id: string; revision_id: number }
  | { status: "invalid"; issues: { path: string; message: string }[] };   // 422
```

`base_rev` and `draft_id` answer different questions and both apply regardless of which phase created
the entry: `base_rev` is the Phase 0 compare-and-swap token for an *edit* to an existing entry (absent
on every create, Phase 2's own or Phase 4's alike); `draft_id` names the Phase 4 `propose()` draft this
commit resolves, when there is one. A Phase 2 caller (search or plan) never sends `draft_id`; a Phase 4
caller (voice, label or photo) always does, and still supplies `base_rev` if it is editing rather than
creating. Neither field implies the other.

Errors: 401 missing or unverifiable session (`getClaims()`, never `getSession()` alone); 409 on a CAS
miss, a tombstone, or an item whose `food_revision_id` is no longer active; 410 on an unknown
`entry_id` with `base_rev` set; 413 over 64 KB; 422 on `grams < 0`, an unknown `food_ref_id`, a
duplicate `seq`, a `local_date` that disagrees with `eaten_at` in `tz`, or a `method` of `voice` /
`label` / `photo` with no `draft_id`; 429 over the rate limit. A replay of the same `entry_id` and body
returns the first result. Offline writes take the Phase 0 path — the outbox enqueues the same payload
as a `log_entries` / `log_items` op, `/api/sync/ops` applies it — and both paths call `applyLogEntry`,
so the snapshot rule cannot diverge.

### `GET /api/export` — JWT, 16 KB, 60/day and 10/hour per user

```ts
// query: kind=meals|progress, format=csv|json, from/to local dates (inclusive, default all),
// cursor (opaque over local_date, eaten_at, id), limit (default and max 5000)
type Nutr = { energy_kcal: number|null; protein_g: number|null; carbohydrate_g: number|null;
  fat_g: number|null; fiber_g: number|null };
export type MealExportRow = Nutr & { local_date: string; eaten_at: string; tz: string; slot: string;
  entry_id: string; item_seq: number; food_name: string; brand: string | null;
  source: string; source_version: string; food_revision_id: number | null;
  qty: number; unit: string; grams: number; note: string | null };
export type ProgressExportRow = Nutr & { local_date: string; day_type: DayType;
  kcal_target: number; micro_coverage_pct: number; items_logged: number };
export type ExportJson<T> = { rows: T[]; next_cursor: string | null; notices: string[] };
```

CSV is streamed (`ReadableStream`), one header line, `text/csv; charset=utf-8`, filename
`sasha-<kind>-<from>-<to>.csv`. Errors: 400 unknown `kind` or `format`; 401; 422 malformed date or
cursor; 429. A page holding an OFF-sourced row carries the ODbL notice as a trailing comment line and
in `notices` (§3.1, §4.6).

**MCP `get_day`** (existing route, `app/api/mcp/route.ts`) gains `nutrients: { code, amount, unit,
coverage }[]` and `micro_coverage_pct`, read through `get_daily_totals(p_user_id, p_local_date)` inside
the privileged wrapper. No new tool, no new scope.

## Client changes

- **`components/LogFoodSheet.tsx`** (rewrite of search/portion). Search calls the Phase 1
  `/api/foods/search`; portions come from `catalog_portions`; the sheet always shows resolved **grams**
  and lets her type grams directly, with a live kcal/protein/carbs/fat/fiber strip.
  **`components/NutrientBreakdown.tsx`** (new) lists every nutrient for one entry: measured values, `—`
  where the source measured nothing, source and source version at the foot.
- **`components/DayNutrients.tsx`** (new, Today, under the rings). Fiber against the 20–25 g band, then
  a coverage pill — "7 of 12 nutrients have data today" — expanding into the tracked set with amount
  and % DRI. Micros are **informational** (§3.1): no rings, no targets, no red states.
- **`components/MacroRings.tsx`** (edit). Same four rings; `consumed` now comes from logged snapshots
  rather than ticked slot estimates. **`components/LoggedExtras.tsx`** (edit): grams and kcal per entry,
  a tap opens `NutrientBreakdown`, unsynced entries carry a pending dot.
- **`components/ExportCard.tsx`** (new) in `app/settings/page.tsx`: meals and progress buttons with an
  optional date range, hitting `/api/export` with the session cookie.
- **Offline.** `lib/db/catalog-cache.ts` (new) caches every catalog revision she touches in IndexedDB —
  per-100 g values, portions, source, revision id. The sheet computes the snapshot locally with the same
  pure function the server uses, writes IndexedDB first, then enqueues the op; the server snapshot
  replaces it on sync. A cache miss with no network blocks that food and says so, never a zeroed item.

## Engines and logic

Pure, no I/O, all new under `lib/`.

```ts
// lib/nutrients/codes.ts — TRACKED_MICROS is the 12 codes seeded in the DRI migration
export const MACRO_CODES = { kcal: "energy_kcal", protein: "protein",
  carbs: "carbohydrate", fat: "fat_total", fiber: "fiber_total" } as const;
export const TRACKED_MICROS: readonly NutrientCode[];
export const FIBER_BAND_G = { min: 20, max: 25 } as const;   // targets.md, not the DRI
// lib/nutrients/snapshot.ts — mirrors compute_item_snapshot exactly
export type NutrientValue = { amount: number | null; unit: string; basis: "per_100g";
  source: string; source_version: string; revision_id: number | null };
export type Snapshot = Record<NutrientCode, NutrientValue>;
export function computeSnapshot(per100g: Record<NutrientCode, number | null>,
  grams: number, meta: SnapshotMeta): Snapshot;
export function snapshotsEqual(a: Snapshot, b: Snapshot, epsilon?: number): boolean;
// lib/nutrients/totals.ts
export type NutrientTotal = { code: NutrientCode; amount: number; unit: string;
  itemsWithValue: number; itemsTotal: number; coverage: number };
export function totalsFor(items: { snapshot: Snapshot }[]): Map<NutrientCode, NutrientTotal>;
export function microCoverage(totals: Map<NutrientCode, NutrientTotal>,
  codes?: readonly NutrientCode[]): { covered: number; tracked: number; pct: number };
// lib/nutrients/dri.ts
export type DriRow = { code: NutrientCode; refType: "RDA"|"AI"|"UL"|"EAR"; value: number; unit: string };
export function percentDri(total: NutrientTotal | undefined, dri: DriRow | undefined): number | null;
export function fiberBandState(fiberG: number | null): "under" | "in-band" | "over" | "unknown";
// lib/nutrients/format.ts — null → "—", never "0"; kcal to 1, macros to 0.1 g, micros to their unit
export function formatAmount(code: NutrientCode, amount: number | null, unit: string): string;
// lib/log/grams.ts — gramsFromUnit returns null when the unit needs a portion
export function gramsForPortion(portion: { gramWeight: number }, qty: number): number;
export function gramsFromUnit(qty: number, unit: LogUnit): number | null;
// lib/export/csv.ts — csvCell prefixes a leading = + - @ with '; ODBL_NOTICE rides OFF-sourced pages
export function csvCell(value: unknown): string;
export function csvDocument(header: string[], rows: readonly (string|number|null)[][]): string;
```

Server-side, not pure: `lib/server/log.ts` (`applyLogEntry` — the single writer behind the commit route
and the sync applier) and `lib/server/export.ts` (`streamMeals`, `streamProgress`, cursor paging).
`scripts/verify-snapshots.ts` (new) prints one date's items with grams, source revision and per-100 g
values, so Devin's USDA check is a comparison, not a hunt.

## Security

Rows this phase activates in the §5 matrix:

| Route | Identity | Body | Rate limit | Idempotency | Notes |
|---|---|---|---|---|---|
| `/api/log/commit` | Supabase JWT | 64 KB | 60/min/user | `entry_id` | rejects stale revisions; RLS (§2.1) |
| `/api/export` | Supabase JWT | 16 KB | 60/day and 10/hour per user | — | user-scoped reads; CSV injection guard |

Rules this phase must hold: the route client is **request-local**, identity comes from `getClaims()`,
and `user_id` is always `auth.uid()`, never read from the body (§2.1); `daily_totals` is
`security_invoker`, granted only to `authenticated`; `get_daily_totals` is `security definer`, revoked
from every client role, reachable only through `lib/server/privileged.ts`, which refuses a call with no
`user_id` (§2.2 rules 3–4); CSV cells starting `= + - @` are prefixed with `'` (§4.6).

## Test plan

**Unit (vitest, new files).** `lib/nutrients/snapshot.test.ts` — scaling, rounding, `null` versus
measured `0`, unit passthrough. `lib/nutrients/totals.test.ts` — sums skip `null` but count it against
coverage. `lib/nutrients/dri.test.ts` — % DRI, `null` on a missing DRI row, fiber band states at
19.9 / 20 / 25 / 25.1 g. `lib/export/csv.test.ts` — `=SUM(A1)`, `+1`, `-1`, `@x`, quotes, newlines,
commas, the ODbL notice. `lib/log/grams.test.ts` — portion × qty, units, a unit needing a portion.

**Integration.** Server snapshot equals client snapshot for 20 catalog foods and 3 of her own. Commit
is idempotent on a replayed `entry_id`. A stale `base_rev` returns `conflict` with the full entity and
writes nothing. A superseded `food_revision_id` is rejected; a tombstoned entry rejects a later update.
Cross-user denial on `daily_totals`, `get_daily_totals`, `/api/log/commit`, `/api/export` and a
`log_items` row whose parent belongs to another user. Timezone: a 23:30 meal lands on the right
`local_date`, a DST-change day totals once. Paging: a 12,000-row log exports with no gap or duplicate.

**Manual gate (Devin, on the phone).** Log five of her meals — a catalog food, a branded food, one of
her own foods, a multi-item meal, and an item edited after saving. Compare kcal, protein, carbs, fat
and fiber against fdc.nal.usda.gov for the same source and grams; all five must match within display
rounding. Then export meals as CSV, open it in Numbers, and confirm grams, source and source version
match what the phone showed.

## Acceptance criteria

1. A logged item stores `grams` and a `snapshot` equal to `compute_item_snapshot(food_ref_id, grams)`.
2. An unmeasured nutrient stores `null` and renders `—`; a measured zero stores `0` and renders `0`.
3. Editing an item's grams recomputes its snapshot; the day's totals move by exactly the difference.
4. `daily_totals` reports per nutrient the amount, `items_with_value`, `items_total` and `coverage`;
   an item with an unknown value lowers that nutrient's coverage and not its total.
5. Today's four rings show kcal, protein, carbs and fat from logged snapshots, equal to `daily_totals`.
6. Today shows fiber in grams with its 20–25 g band state, and a pill reading "*n* of 12 nutrients
   have data today" that matches `microCoverage`.
7. An entry logged offline appears on Today at once with client values; after sync the displayed
   values equal the server snapshot.
8. `/api/log/commit` replayed with the same `entry_id` and body returns the first result and creates
   no second entry; with a stale `base_rev` it returns 409 `conflict` carrying the full current
   entity and leaves the stored entry unchanged.
9. `kind=meals&format=csv` returns one row per logged item carrying `unit`, `grams`, `source` and
   `source_version`, and a food name starting `=` exports prefixed with `'`.
10. `kind=progress&format=csv` returns one row per local date with totals, kcal target and
    `micro_coverage_pct`.
11. A second user reading `daily_totals`, calling `/api/export`, or committing against her `entry_id`
    gets zero rows or a 4xx, never her data.
12. MCP `get_day` returns the kcal, macros, fiber and coverage the phone shows for that date.
13. `pnpm test`, `pnpm lint` and `pnpm build` pass; the five-meal manual gate passes.

## Rollout and rollback

One branch, `feat/phase-2-real-logging`, one squashed commit. Apply the four migrations on a Supabase
branch of `fivatgdpuenszxxnijpc`, run the integration tests against it, merge the branch, then merge the
PR so Vercel deploys from `main`. The migrations are additive and rewrite no existing row, so deploy and
migration may land minutes apart without data loss.

Rollback: revert the app commit; Today falls back to Phase 0 behaviour. The down migration
(`..._phase2_down.sql`, written alongside the up migrations) drops `get_daily_totals`, `daily_totals`
and `compute_item_snapshot`, and keeps the DRI rows, the indexes and every `log_items.snapshot` —
logged data is never dropped. If a snapshot defect ships, `scripts/verify-snapshots.ts --repair <from>
<to>` recomputes from the active revisions and bumps each entry's `rev`, so other devices pull the
correction through `change_log`.

## Open questions

1. **Coverage denominator.** §3.3 specifies items-with-value ÷ all items, so a 5 g sprinkle of an
   uncharacterised spice costs as much coverage as a 200 g main. Grams-weighted coverage reads truer;
   this spec follows the architecture, and a change needs an amendment there.
2. **The tracked micro set.** Twelve codes are proposed (fiber, sodium, potassium, calcium, iron,
   magnesium, zinc, vitamin C, vitamin D, B12, folate, vitamin A). Devin confirms the list before the
   DRI seed lands, because the set defines the coverage denominator on her screen.
3. **% DRI display, and fiber versus the AI.** A percentage beside a nutrient can read as a medical
   instruction; proposal is amount first, percentage muted, no colour states, no "low" wording. Her
   fiber band (20–25 g) sits below the 25 g AI — confirm the screen shows only the band.
4. **Item-level breakdown and `unit` vocabulary.** The nutrient sheet opens per entry; per-item
   drill-down waits until she has used it for a week. `log_items.unit` stays free text in Phase 2,
   which writes only `g`, `oz`, `portion` and `each`; a check constraint is a Phase 3 decision, when
   barcode and recipe items widen the set.
5. **No phase owns exercise data.** `architecture.md` §1 and §4.6 carry "exportable ... exercise data"
   and an `exercise` export kind forward from the brief, and this spec used to defer `exercise` to
   "Phase 3+" — but Phase 3 (`phase-3-fast-capture.md`) only adds `kind=recipes|favorites|water`, and no
   phase spec creates an exercise-logging table or feature row. This spec removes the false "Phase 3+"
   promise (above, Scope) rather than repeat it. Resolving this needs either a new feature row and an
   owning phase for exercise logging, or dropping "exercise" from architecture.md §4.6's export kind list
   and the brief's carried-forward requirement — a decision this file cannot make alone.
