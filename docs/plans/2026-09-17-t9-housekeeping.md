# T9 — Housekeeping — 2026-09-17

Program: `docs/plans/2026-09-17-fab-coach-program.md` (T9). Size S.
Coder: Opus 5. Panel holds AC1–AC6 outside the repo. Adversary: Grok 4.6.
Runs in parallel with T0 and T8 on its own branch `feat/t9-housekeeping`, from `main` at fa81313.
No behaviour changes except §4 and §5, which are bug fixes with their own tests.

## What the recon found

1. **`components/TabBar.tsx:49` hydration mismatch — already closed.** PR #141 (`4e642d8`) keeps
   the server-matching `"unknown"` initial state and applies the warm cache in a layout effect after
   hydration. `tests/tabbar/body-capability-first-paint.test.tsx` asserts server markup equals the
   client's pre-effect markup. Nothing to code. T9 records the disposition (§6) and leaves the
   residual cold-cache one-paint shift of the Body tab alone (a layout shift, not a mismatch).
2. **`app/settings/page.tsx` is 539 lines** (budget 400). The constraints editor is gone cleanly;
   the excess is local helpers and two large cards that belong in their own files.
3. **`lib/server/log.ts` is 536 lines.** The label-food path and the day-totals readers are
   separable units with distinct callers.
4. **Search never consults the profile's avoid list.** `lib/server/catalog.ts:192` and `:266`
   build policy evidence with `foodRefId: null`, and `evaluatePolicy` (`lib/policy/constraints.ts:62`)
   only matches `avoid_food_ref_ids` on a non-null ref. The ref is known at both sites (the hit's
   `food_refs` row is what `prefStatusFor` reads). So a coach action that adds a food to
   `avoid_food_ref_ids` (`lib/coach/types.ts:62,71`, the only writer) blocks the barcode, capture
   and commit paths but not search or the detail sheet.
5. **`perUnitTo100g` writes keys no reader understands.** `lib/units.ts:152-162` returns
   `{ protein_g, carbohydrate_g, fat_g, energy_kcal }`; `lib/foods/prefs-client.ts:103` and
   `lib/migrate/legacy.ts:75` write that object into `user_foods.per_100g`. The only consumer,
   `compute_item_snapshot` (`supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql:16-18`),
   inner-joins `jsonb_each(per_100g)` on `catalog_nutrients.code` (`energy_kcal, protein,
   carbohydrate, fat_total`, `lib/nutrients/codes.ts`). Three of four macros are silently dropped
   from every snapshot of a user food written through those two paths.
6. **`docs/features.md` is stale by design note.** Its own lines 11-19 say every phase 1-7 row
   still reads `planned`. 64 rows say `planned`; at least F-093, F-051, F-058, F-060, F-061 are
   running in production. F-001 says the tab bar holds Today · Week · Foods; Week is not a tab.

## Design

### 1. `app/settings/page.tsx` under 400 lines — a move, not a rewrite

- `components/settings/settings-styles.ts`: the style constants (lines 29-61).
- `components/settings/MacroList.tsx`: `MacroList` (86-113) and the `Card`/`PillButton` helpers
  if they are only used by the moved cards; otherwise they stay.
- `lib/settings/date.ts`: `todayIso`, `isoDaysBefore`, `isSameLocalDay`, `formatKcal` (116-146).
- `components/settings/CaloriesCard.tsx` (the training/rest calorie card, 392-430) and
  `components/settings/ProteinLockCard.tsx` (432-493), each taking the values and the setters
  they use as props. State and the `commit()` writers stay in the page.
- Markup and behaviour are identical: the page renders byte-identical static markup for the
  same state before and after (AC1). No copy changes, no class changes.

### 2. `lib/server/log.ts` under 400 lines — a move, not a rewrite

- `lib/server/log-label-food.ts`: `LABEL_FOOD_PLACEHOLDER_REF`, `LabelFoodInput`,
  `labelFoodSchema`, and the label-food branch of the commit path (the functions around lines
  153-260 and 400-480 that only the label path uses). T3 will rework this file; giving it its own
  file now is the point.
- `lib/server/day-totals.ts`: `dayTotals` and `dayTotalsPrivileged` (123-142) with their types.
- `lib/server/log.ts` keeps `applyLogEntry` and re-exports nothing; callers import from the new
  files: `app/api/log/commit/route.ts`, `app/api/mcp/route.ts`, `lib/server/coach.ts` (its dynamic
  import), `lib/coach/weekly-review.ts`, and the tests. The comment references in
  `lib/log/contract.ts:7` and `lib/log-client.ts:267` are updated.
- Existing tests keep passing unchanged except for import paths.

### 3. `docs/features.md` says what runs

- Every row whose disposition is `planned` is checked against the code. If the feature runs, the
  row becomes `exists` and its notes name the implementing file. If it does not, the row stays
  `planned` and its notes say what is missing, in one line. `deferred` and `rejected` rows are
  untouched.
- F-001 names the current tabs: Today, Body (when the capability is on), Foods, Settings.
- The stale-by-design paragraph at lines 11-19 is removed once no row lies.
- Rows F-028, F-032 and F-065 are **left alone**: T8 owns them and lands in parallel.
- A guard so it does not rot again: `scripts/check-features.ts` (run by `pnpm lint:docs`, added to
  the `lint` script) fails when a `planned` row's notes name a file that exists in the repo, or an
  `exists` row's notes name a file that does not. Notes therefore carry the file path in
  backticks. This is the whole check; nothing cleverer.

### 4. Search and the detail sheet honour `avoid_food_ref_ids`

- `lib/server/catalog.ts`: the two evidence builders pass the hit's `food_refs.id` as
  `foodRefId` instead of `null`. Nothing else changes; precedence stays allergen >
  `avoid_food_ref_ids` > `onAvoidList` > category > unverified > allowed.
- The `search does not resolve refs` comment is corrected.
- `docs/features.md` F-057/F-076 notes say search honours both her marks and the coach's list.

### 5. `perUnitTo100g` speaks the canonical codes

- `lib/units.ts:perUnitTo100g` returns `{ energy_kcal, protein, carbohydrate, fat_total }`
  (`NUTRIENT_CODES` from `lib/nutrients/codes.ts`). Every reader of the old keys in the client
  (grep `protein_g`, `carbohydrate_g`, `fat_g` outside catalog types) is updated in the same
  change; the coder lists them in the report.
- Migration `supabase/migrations/<ts>_per_100g_canonical_keys.sql` (+ `.down.sql`): one idempotent
  `update user_foods set per_100g = …` that renames the three old keys where present and leaves
  canonical keys alone. It reports the row count in a `raise notice`. Applied to the local stack
  by the coder; to production by the driver at landing, with the count recorded.
- Existing `log_entries` item snapshots are history and are not recomputed.

### 6. Dispositions recorded

`docs/features.md` and `docs/architecture.md` get one line each for: TabBar hydration closed by
PR #141 with the regression test named; the residual cold-cache shift as a known, accepted
one-paint layout shift.

## Out of scope

Any visual change; `lib/store.ts`; the Body tab cold-cache shift; snapshot recomputation; the
`/settings` copy; anything T0 or T8 touches (`components/MacroRings.tsx`, `app/page.tsx` weight
and water code, `lib/server/capture.ts`, `lib/server/barcode.ts`, the client fetch modules).

## Acceptance criteria (the panel's, hidden from the coder)

- **AC1** `app/settings/page.tsx` ≤ 400 lines, and for a fixed store/state the page's static
  markup is byte-identical to `main`'s.
- **AC2** `lib/server/log.ts` ≤ 400 lines; `applyLogEntry`, `dayTotals`, `dayTotalsPrivileged`,
  `labelFoodSchema`, `LABEL_FOOD_PLACEHOLDER_REF` are importable from the files §2 names; the
  commit route still commits a normal entry and a label-food entry exactly as on `main`.
- **AC3** `docs/features.md`: F-093, F-051, F-058, F-060, F-061 read `exists`; F-001 names Today,
  Body, Foods, Settings; no row reads `planned` while naming a file that exists;
  `pnpm lint:docs` exists and fails on a seeded lie.
- **AC4** A profile with `avoid_food_ref_ids = [ref]` blocks the search hit for `ref` and the
  detail view for `ref`, with the profile-list reason; an allergen hit still outranks it; a hit
  not on the list is unchanged.
- **AC5** `perUnitTo100g` returns exactly the four canonical codes; a `user_foods.per_100g`
  written through `per100gFor` yields all four nutrients from `compute_item_snapshot` on the local
  DB; the migration renames `{protein_g, carbohydrate_g, fat_g}` and leaves canonical rows
  untouched (idempotent on a second run).
- **AC6** No regression: `pnpm test` once green, tsc, lint (now including `lint:docs`), design
  lint. `TabBar` first-paint test still passes.

## Proof folder — `~/Desktop/proof/t9-housekeeping/`

`acceptance-criteria.md`, `AC1..AC6.txt`, `grok-review.md`, `production-evidence.md` (migration
applied with the renamed-row count, deploy sha, one production search of a coach-listed food
blocked).
