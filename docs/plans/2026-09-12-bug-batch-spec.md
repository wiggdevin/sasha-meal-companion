# Bug batch and small features — spec, 2026-09-12

Source: Devin's phone pass on production, 2026-09-12 (bug log
`~/Inbox/notes/sasha-bug-log-2026-09-12.md`). Base: `main` at `acdc1b1`.
Fixer lane: DeepSeek V4.1 Flash (`codex-deepseek exec`, model id `deepseek-flash`). Auditor: GPT-5.6
Sol at `high`, read-only. One ticket = one branch = one PR. CI is the one full test run.

Rules every ticket obeys (from `AGENTS.md`): no food or meal ever contains apple, gluten or dairy; a
calorie change never moves protein; any date renders; `DESIGN.md` is the design contract (system
font, 4 px rhythm, 44 px targets, fixed gauge colours, no video or flame grounds); files under
400 lines, functions under 50; conventional commits; run only the touched spec files plus `pnpm lint`
and `pnpm exec tsc --noEmit` before the PR.

## Rulings recorded this session (Devin, in writing, 2026-09-12)

- R1. Catalog relevance gate: **top-1 ≥ 82 %** (was 85 %), top-3 unchanged at 95 %. The Lane O
  measurement (83.6 % / 100 %) therefore passes. `NEXT_PUBLIC_CATALOG_SEARCH` goes on in production
  once the catalog is imported there. "As long as we have fuzzy search, we're good."
- R2. Coach goes live for recommendations and questions, inside the Phase 7 tool set. Nous stays
  rejected (`docs/ai-data-handling.md`); the coach runs on Gemini once billing is confirmed.
- R3. Feature requests F-01 (water), F-02 (day toggle), F-03 (notes) enter this batch.
- R4 (Devin, 22:05Z, in writing: "YES"). Health-context coach turns (her profile carries
  ulcerative colitis, so that is every turn) may go to **Gemini on the paid tier**, once billing
  and prompt-logging are attested. Nous stays rejected. T4 ships the switch
  (`HEALTH_CONTEXT_PROVIDER=gemini` + `GEMINI_BILLING_ATTESTED=1`); T9 sets both in Vercel after
  the attestation. Update `docs/ai-data-handling.md` "Data sent" in the T4 PR: gut and condition
  notes may reach Gemini paid tier under R4; never an unpaid project, never Nous.
- R6 (driver, 2026-09-13 00:20Z, from the Sol second audit of T1). A recipe is a meal she
  plans, so it obeys the domain rule "no meal anywhere contains apple, gluten or dairy": the
  recipe sheet rejects an off-plan ingredient in both tiers (row stays visible and marked;
  tapping it says "Not on her plan (gluten)"). Logging stays "marking, never hiding". Main
  already allowed off-plan catalog rows into recipes; T1 closes that too.
- R5 (Devin, 22:05Z). Oura: path B — the OAuth app is registered under Sasha's own Oura
  account, with Devin at the laptop with her. Path A is not pursued.

## Tickets

### T1 — Recipe sheet: ingredients from the bundled list when the catalog is off (B-02, P0)

- **Files:** `components/RecipeSheet.tsx`, `lib/recipes-client.ts` (read), `components/LogFoodSheet.tsx:246,295-301` (pattern to copy).
- **Change:** `RecipeSheet` mirrors `LogFoodSheet`: when `catalogSearchEnabled()` is false, render the
  bundled `searchFoods(query, mine)` list instead of `<CatalogSearch>`. When it is true and a row comes
  back offline-tier (`row.offline || row.catalogFoodId === null`), add the ingredient from
  `row.offlineFoodId` the way `LogFoodSheet.pick()` does, instead of `return`. Never a silent no-op:
  if a row truly cannot be added, show an inline line under the search ("Can't add this one right
  now") for one render.
- **Recipe item shape:** confirm what `saveRecipe` needs per item (catalog id vs bundled id). If the
  recipe item type requires `catalogFoodId`, extend it with the same optional `offlineFoodId` /
  per-100 g macro snapshot `LogFoodSheet` stores, so a saved recipe resolves without the catalog.
- **Eval:** `tests/recipes/recipe-sheet-offline.test.tsx` (new): with `NEXT_PUBLIC_CATALOG_SEARCH`
  unset, typing "chicken" and tapping the first row adds an item and enables Save; saving calls
  `saveRecipe` with one item. Second case: flag on, mocked `searchFoods` returning an offline row →
  same result. Both fail on `main` today.
- **Acceptance:** on production (catalog off) a recipe with three bundled ingredients saves and shows
  in `/recipes`.

### T2 — "Log a food" sheet: the Type / Speak / Scan / Photo row does something or goes away (B-03, P1)

- **Files:** `components/LogFoodSheet.tsx:84-154` (`CaptureRow`), `lib/capture-client.ts`
  (`captureActions`, `CAPTURE_LABELS`), `app/page.tsx:598-636` (how `CaptureSheet` is opened).
- **Change:** `CaptureRow` takes the real `captureActions()` list. Each enabled method renders as a
  live button that closes the sheet and opens the same capture flow the FAB uses (pass an
  `onCapture(method)` prop from `app/page.tsx`, which calls the existing `setCaptureOpen(method)`
  path). When `enabledMethods()` is empty (production today) the row is **not rendered**. Remove
  `aria-disabled`/`opacity-50`/`tabIndex={-1}` placeholders and the "Phase 4 wires them up" comment.
  Barcode "Scan" follows `NEXT_PUBLIC_FEATURE_SCAN` exactly as `QuickActions` does.
- **Eval:** `tests/log/capture-row.test.tsx` (new): flags unset → no capture buttons in the sheet;
  `NEXT_PUBLIC_CAPTURE_METHODS=text,photo` → exactly two buttons, tapping "Type a meal" calls
  `onCapture("text")`. Fails on `main` (row is always four dead buttons).
- **Acceptance:** production shows no dead buttons; with capture on, the row works.

### T3 — Week tab: tap a past day to see that day (B-01, P1)

- **Files:** `components/WeekGrid.tsx`, `app/week/page.tsx`, `app/page.tsx:141-197` (`viewedDate`).
- **Change:** each day cell becomes a `<button>` (44 px target) with `aria-label` "Mon 8 Sep, on
  plan". Tap → `router.push("/?d=YYYY-MM-DD")`. `app/page.tsx` reads `d` from the URL on mount (a
  valid ISO date) and sets `viewedDate` to it; an invalid or missing `d` keeps today. The Today
  screen already supports `isPastDay`/`isFutureDay` states — reuse them. Add a small "Back to today"
  affordance when `viewedDate !== todayIso` if one does not exist (check first; `app/page.tsx` may
  already have day navigation — reuse, do not duplicate).
- **Eval:** `tests/week/day-tap.test.tsx` (new): rendering `WeekGrid` with 7 days and tapping the
  third calls the navigation callback with that ISO date; `app/page.tsx` with `?d=2026-09-08` renders
  that date's plan (assert the header date). Fails on `main`.
- **Acceptance:** on the phone, scroll back two weeks, tap Wednesday, see that day's meals, rings
  and water.

### T4 — Coach and weekly review route per the data-handling record (B-04)

- **Files:** `lib/ai/adapter.ts:15-22,170,326`, `lib/server/coach.ts:31-58,246,293`,
  `docs/ai-data-handling.md`, `docs/coach-deflection.md`.
- **Change:** the adapter no longer hard-routes `coach` and `weeklyReview` to Nous. `coachProvider()`
  / `coachModelId()` in `lib/server/coach.ts` become the single authority and are passed into
  `generate` (add an optional `provider`/`model` override to `GenerateArgs`, defaulting to the
  adapter table for capture purposes). With `NOUS_RETENTION_CONFIRMED=false`: non-health turns and
  the weekly review go to Gemini `gemini-3.8-flash`; health-context turns keep the `503
  nous_unconfirmed` refusal. Remove `NOUS_COACH_MODEL_ID` / `NOUS_REVIEW_MODEL_ID` from the read path
  or leave them inert with a comment. Update `docs/ai-data-handling.md` "Pinned" rows for Coach and
  Weekly review.
- **Eval:** `tests/coach/provider-routing.test.ts` (new): with the retention flag false, a
  non-health turn calls the Gemini stub and never the Nous stub; a health-context turn calls neither
  and returns 503; the weekly review job calls Gemini. Fails on `main` (Nous stub is called).
- **Acceptance:** `pnpm vitest run tests/coach` green; `scripts/coach-injection-canary.ts` still
  resolves the provider through `coachProvider()`.

### T5 — Toggle and lock a day as training or rest from the Today header (F-02)

- **Files:** `app/page.tsx:94,368` (day-type chip), `lib/types.ts:135` (`dayTypeOverride`),
  `lib/plan.ts:56-59`, `lib/store.ts` (`updateDay`), `lib/sync/*` (confirm `dayTypeOverride` rides
  the existing day op; add it if the op schema whitelists fields), `app/api/mcp/route.ts` (read-only
  echo already exists).
- **Change:** the chip becomes a button (44 px) that opens a small sheet: "Training day" / "Rest day"
  rows plus "Follow the schedule". Choosing a type writes `dayTypeOverride` for `viewedDate` and
  shows a lock glyph on the chip; "Follow the schedule" clears it. Copy: "Locked as a rest day —
  calories follow." Targets recompute through `resolveTargets` with no other change (protein never
  moves, per `lib/scaling.ts`). Wednesday's `training-7-fasted` maps to "Training day" when locked
  from a rest day; the sheet offers only `rest` and the weekday's training variant. The override
  applies to that date only.
- **Eval:** `tests/today/day-type-toggle.test.tsx` (new): tapping the chip, choosing "Rest day" on a
  Monday writes `dayTypeOverride: "rest"`, the rendered calorie target equals the rest target for the
  ramp stage, and protein grams are unchanged; "Follow the schedule" removes the override. Fails on
  `main` (chip is not interactive).
- **Acceptance:** on a training day, lock as rest; calories drop to the rest target; unlock restores.

### T6 — Water in cups and ounces, goal per day type, goal marker (F-01)

- **Files:** `components/WaterCard.tsx`, `lib/water.ts`, `lib/water-client.ts`, `lib/server/export.ts:458-466`,
  a new migration `supabase/migrations/<ts>_water_goal_by_day_type.sql`, `app/settings/page.tsx`.
- **Change:**
  1. Display `{cups} cups · {oz} oz` where oz = cups × 8 (US cup; `CUP_ML` stays 240 for the merge
     rule). Stepper stays one cup.
  2. Goal per day type: `user_settings` gains `water_goal_cups_training` and `water_goal_cups_rest`
     (int, check 1–30, default 8 each, backfilled from `water_goal_cups`). `getWater(localDate)`
     returns the goal for `dayTypeFor(localDate, override)` via `categoryFor`. The in-card goal
     stepper edits the goal for the viewed day's type and says which one ("Training-day goal").
     Range in the UI: 1–16 cups (a gallon is 128 oz = 16 cups); the column check stays 1–30.
  3. Goal marker: a fixed tick at the goal position on the bar, with the bar scale = max(goal,
     cups). Rendered as SVG/CSS with a soft pulse when met (`prefers-reduced-motion` disables it).
     **Not WebGL:** a canvas on a 4 px bar is outside the design contract's glass system and costs
     battery; if Devin still wants WebGL after seeing this, it becomes its own ticket.
- **Eval:** `lib/water.test.ts` (extend): `cupsToOz(6) === 48`; `goalFor("training-10", s) ===
  s.water_goal_cups_training`. `tests/water/card.test.tsx`: card shows "48 oz" for 6 cups and the
  training goal on a Monday. Migration test: existing `water_goal_cups=10` backfills both columns
  to 10. Fails on `main`.
- **Acceptance:** Today shows cups and oz; goal differs between a Monday and a Tuesday after editing.

### T7 — A bad note on a food offers "Move to Avoid?" (F-03)

- **Files:** `components/FoodSheet.tsx:46-79`, `lib/foods.ts` (new pure `noteSuggestsAvoid(note)`),
  `lib/foods.test.ts`.
- **Change:** on note blur, if `status === "eats"` and `noteSuggestsAvoid(note)` is true, show one
  inline row under the note: "Sounds like this one hurt. Move to Avoid?" with a single tap that sets
  `status: "avoid"` (the note is kept, per the data model). Keyword list (word-boundary, case-
  insensitive): hate, hated, hurt, sick, tired, bloat, bloated, flare, pain, nausea, cramps, gassy,
  awful, never again. No model call. The row never appears for foods already on Avoid.
- **Eval:** `lib/foods.test.ts`: `noteSuggestsAvoid("hated it and made me feel tired")` true,
  `("great with rice")` false. `tests/foods/note-avoid.test.tsx`: typing that note shows the row,
  tapping moves the food to Avoid and keeps the note. Fails on `main`.
- **Acceptance:** on the phone, write "hated it" on a food → offer appears → tap → food is on Avoid
  with the note, and it leaves the rotation (existing rule).

### T8 — Catalog search on in production (R1) — ops ticket, not a code fix

1. Record R1 in `docs/catalog/relevance.md` (new section "Gate lowered 2026-09-12 by Devin: top-1 ≥
   82 %") and in `docs/decisions/2026-09-12-session-rulings.md`.
2. **Owner step (Devin):** production has **zero** catalog rows (`catalog_versions` is empty,
   checked 20:40Z). Add the production direct Postgres URL to ZS Vault as
   `sasha_supabase_db_url` (Supabase dashboard → Connect → session pooler URI with the database
   password). No agent can mint it.
3. Then: `CATALOG_IMPORT_DB_URL=$(zsvault get sasha_supabase_db_url) .venv/bin/python
   scripts/import-fdc.py --version-label 2026-09-12` from the repo (runbook
   `docs/catalog/import.md`; zips already cached in `~/Backups/usda/fdc/2026-09-12/`). Verify:
   `select count(*) from catalog_foods` ≈ 13,694 and one active label.
4. `npx vercel env add NEXT_PUBLIC_CATALOG_SEARCH production` = `1`, then redeploy (merge any PR or
   `vercel redeploy`; `vercel --prod` stays denied).
5. Re-run `scripts/search-eval.ts` against production with the eval user; append the number to
   `relevance.md`. Expected ≈ 83.6 % top-1 (≥ 82 % passes).
6. T1 still lands regardless: the sheet must work when the catalog is unreachable.

### T9 — Coach on in production (R2) — ops ticket after T4

1. **Owner step (Devin):** enable Cloud Billing on the Gemini project and confirm it in the AI
   Studio console; confirm prompt logging is off for the key. `pnpm ai:canary` must read a positive
   paid signal (`docs/ai-data-handling.md`).
2. `COACH_ENABLED=1` and `NEXT_PUBLIC_COACH_ENABLED=1` in Vercel production, together.
3. Run the live canary once and commit `docs/coach-canary-2026-09-XX.md`.
4. Same billing step unlocks AI capture: set `CAPTURE_METHODS` / `NEXT_PUBLIC_CAPTURE_METHODS` to
   `text,photo,label` first; `voice` waits on the real-phone audio canary.

### T10 — Oura for Sasha without Devin's credentials — decision, not code

Oura retired personal access tokens in December 2025; OAuth is the only way in, and OAuth needs a
registered developer app. Two ways that need nothing from Devin's own accounts:

- **A (recommended, zero setup):** Oura app → Settings → Apple Health → sync on. Health Auto Export
  (the path already chosen and gated, `docs/health-auto-export.md`) then delivers sleep, resting
  heart rate and HRV — all three are already in `INGEST_SAMPLE_TYPES`. Code change: none. Doc
  change: add `Heart Rate Variability` and `Resting Heart Rate` to the HAE metric list in step 5.
  Readiness score is the one Oura value this path cannot carry.
- **B (if readiness score matters):** register the developer app under **Sasha's** Oura account
  (cloud.ouraring.com → OAuth applications; redirect
  `https://sasha-meal-companion.vercel.app/api/health/oura/callback`), five minutes with her at a
  laptop. Put the client id, client secret, `OURA_REDIRECT_URI` and a fresh `HEALTH_TOKEN_KEY` into
  Vercel, flip `HEALTH_INGEST_ENABLED`, and the existing "Connect Oura" button does the rest.

Either way `HEALTH_INGEST_ENABLED` must be on for the Body data card to appear at all.

### T11 — TDEE and Apple Health, visible without digging (added 21:10Z)

What exists (Phase 5 + 6): an adaptive TDEE (`lib/expenditure.ts:248-321`, intake average minus
weight-trend slope, seeded by `PRIOR_KCAL`/`BMR_KCAL` from `analysis/targets.md`), written nightly
to `expenditure_estimates` by `/api/jobs/estimate`; a `/body` dashboard (weight, sleep, steps,
active energy, 7-day sparklines) fed by `daily_health`; a weight pill on Today. All hidden behind
`HEALTH_INGEST_ENABLED`, `ESTIMATOR_ENABLED`, `NEXT_PUBLIC_ESTIMATOR_UI`. `/body` is reachable only
from Settings → Body data → View. The estimator never reads Apple Health active energy or steps,
and no formula TDEE exists. RHR and HRV are accepted by ingest but not rolled up or shown.

Rule that bounds this ticket: `analysis/targets.md` owns every calorie number and the estimator
proposals are the only path that changes targets. Nothing here writes targets.

- **T11a — Body on Today and in the tab bar.** `components/TabBar.tsx:89-95` gains a **Body** tab
  (between Week and Foods) when `bodyDataCard()` is not hidden (same gate as the Settings card; the
  client learns it from `/api/health/daily` once per session, cached). Today gets a compact "Body"
  card under Water: steps, sleep (h:mm), active energy (kcal), weight (lb) for the viewed date from
  `daily_health`, each with its source glyph (Apple Health / Oura) and "as of" time, and a one-line
  TDEE row (see T11b). Tapping the card opens `/body`. Empty state: "No body data yet — connect a
  source in Settings." Files: `components/TabBar.tsx`, `app/page.tsx`, new
  `components/BodyTodayCard.tsx` (≤ 120 lines), `lib/health-client.ts`.
  Eval: `tests/body/today-card.test.tsx` — with a mocked daily row the card renders the four values
  and the sources; with none, the empty line; tab bar shows Body only when the card is not hidden.
- **T11b — TDEE the app can explain.** New pure `lib/tdee.ts`: `bmrKatchMcArdle(weightKg, bodyFatPct)`
  and `bmrMifflinStJeor(weightKg, heightCm, ageYears, sex)`; `activityTdee(bmr, activeKcal7dAvg)`
  = bmr × 1.1 (TEF) + active energy 7-day average from `daily_health.active_kcal`. Inputs (height,
  age, sex, body-fat %) live in `user_settings` as new nullable columns via one migration
  (`height_cm`, `birth_year`, `sex`, `body_fat_pct`), editable in Settings → Body data. The
  `/body` page and the Settings `EstimatorCard` show **three** lines with plain labels: "Adaptive
  (from your logs and weight)" = `expenditure_estimates.tdee_kcal` (or "still learning" in burn-in);
  "Formula" = Katch-McArdle when body-fat % is set, else Mifflin-St Jeor; "Activity (Apple Health)"
  = `activityTdee`, shown only when active energy has ≥ 3 of the last 7 days. Every line names its
  inputs on tap. None of these numbers changes a target; the card says "Targets change only through
  the weekly proposal." `user_settings` columns must join the sync-entity column list in
  `_sync_upsert` (`supabase/migrations/20260919090300_phase3_sync_entities.sql:240-244` pattern) and
  the export (`lib/server/export.ts`). Files: `lib/tdee.ts` (+ `lib/tdee.test.ts`),
  `components/EstimatorCard.tsx`, `components/BodyDashboard.tsx`, `app/settings/page.tsx`,
  `lib/health/daily.ts` (add `resting_heart_rate`, `hrv_sdnn` to the roll-up and two cards on
  `/body`), one migration. Eval: `lib/tdee.test.ts` — Mifflin 70 kg / 165 cm / 30 y / female =
  1,410 kcal (±1); Katch-McArdle 70 kg / 25 % = 1,504 (±1); `activityTdee(1500, 400)` = 2,050;
  `tests/body/tdee-lines.test.tsx` — burn-in shows "still learning" for adaptive and still shows the
  formula line. Fails on `main` (no `lib/tdee.ts`).
- **T11c — ops.** After T10's `HEALTH_INGEST_ENABLED`, also set `ESTIMATOR_ENABLED=1` and
  `NEXT_PUBLIC_ESTIMATOR_UI=1` in Vercel production. The estimator needs ≥ 20 weigh-ins before it
  leaves burn-in, so the formula and activity lines are what she sees first.

## Sol audit fixes (GPT-5.6 Sol, high, 2026-09-12 21:20Z) — these amend the tickets above

Read this section as overriding anything it contradicts in a ticket.

**Cross-ticket**
- **Test harness.** Vitest runs in the Node environment (`vitest.config.ts`) and React Testing
  Library is not installed. Do not add it. Every eval is (a) a pure-helper test and/or (b) a static
  render with `renderToStaticMarkup` from `react-dom/server` asserting markup (labels, hrefs,
  counts, `aria-*`). Interaction (tapping, typing) stays a manual phone gate; extract the state
  transition into a pure function and test that. Follow `tests/health/sparkline.test.ts` as the
  pattern.
- **File size.** `LogFoodSheet.tsx` (828 lines), `app/page.tsx` (698), `lib/server/coach.ts` (447),
  `lib/ai/adapter.ts` (399) are at or over the 400-line limit. Every ticket that touches one of
  them extracts its new code into a new file (component or helper) and adds only the import and a
  few lines to the big file. Never grow those files.
- **Local test runs.** Run only the spec files you touched plus `pnpm lint` and `pnpm exec tsc
  --noEmit`. The full `pnpm test` runs once, in CI. (House rule 2026-09-05 wins over `AGENTS.md`'s
  "run pnpm test once locally".)
- **Two stores.** Release A keeps the legacy localStorage/snapshot store beside the normalized
  op-log entities. When a ticket writes state, say which store, and if a normalized entity exists
  for it, write through the normalized boundary too (T5, T6). T7 stays legacy-only (documented).

**T1 (was BLOCK).** A recipe item needs a canonical `food_refs` row (`recipe_items.food_ref_id`
is a required FK); the bundled list has no such row. Path: new `lib/foods/adopt-client.ts`
`adoptBundledFood(bundledId)`: (1) upsert a `user_foods` row with `kind: 'custom'`, a
deterministic id (UUID v5 of `bundled:<id>`, so repeats are idempotent), `name` and `per_100g`
from the bundled entry's per-100 g values (map the bundled keys to the nutrient codes the app
uses — read `lib/recipes/nutrients.ts` and `daily_totals`), through the browser Supabase client
(RLS is owner-scoped; verify the insert policy in `20260911000500_rls.sql`); (2) call the existing
RPC `get_or_create_food_ref(p_user_id, 'user', null, <userFoodId>)`; (3) return `{ foodRefId,
per100g }`. `RecipeSheet.addFood` uses it for offline-tier rows, and when
`catalogSearchEnabled()` is false renders the bundled `searchFoods` list (as `LogFoodSheet` does).
If adoption fails (offline, RLS), show "Can't add this one right now" under the search — never a
silent return. Eval: pure tests for the id derivation and the per-100 g mapping; a static render
of the sheet with the flag off showing bundled rows; an env-guarded integration test in `tests/`
(`SUPABASE_TEST_*`) that adopts one bundled food, gets a food ref, saves a one-item recipe and
reads it back. Also add the adopted food to the local `foods` map? **No** — keep it out of the
Foods tab and the rotation (scope), note this in the PR.

**T2.** The setter is `setCaptureMode` (`app/page.tsx:628`), not `setCaptureOpen`. Extract
`components/CaptureRow.tsx` (props: `actions`, `onCapture`, `scan?`); `LogFoodSheet` closes
itself (`onClose()`) before `onCapture(method)` sets the mode. "Scan a label" is the `label`
capture method; the barcode scanner is a separate optional action gated by
`NEXT_PUBLIC_FEATURE_SCAN`, exactly as `QuickActions.tsx:126`. Eval: static render with
`captureActions()` stubbed to `[]` → no buttons; to two methods → two buttons with the
`CAPTURE_LABELS` text; pure test of the close-then-open handler.

**T3.** Render each day as an `<a href="/?d=YYYY-MM-DD">` inside the existing `listitem` (keeps
list semantics; 44 px). New pure `lib/url-date.ts` `parseUrlDate(s)` that rejects malformed and
impossible dates (`2026-02-30`), tested. `app/page.tsx` reads `d` on mount via
`useSearchParams` in a small extracted client component (or `window.location` in the existing
mount effect) and sets `viewedDate`; the existing Back to today / prev / next controls
(`app/page.tsx:436`) are reused. The accessible label uses the computed status text, not a
hardcoded "on plan". Eval: static render of `WeekGrid` asserting the seven hrefs; `parseUrlDate`
cases.

**T4 (was BLOCK).** Routing fix as written, plus: (a) a policy switch, env
`HEALTH_CONTEXT_PROVIDER` — unset keeps today's `503 nous_unconfirmed` for health-context turns;
`gemini` lets them through to Gemini only, and only when `GEMINI_BILLING_ATTESTED=1` is also set
(a manual attestation env, not an inference). Sasha's profile carries "ulcerative colitis", so
without this switch the coach returns 503 on every turn; **turning the switch on is Devin's
ruling R4, still pending** — the code ships with it off. (b) Persist the real provider/model on
weekly-review messages (`coach.ts:437`). (c) `scripts/ai-canary.ts` must stop probing Nous and
must never overwrite the retention record in `docs/ai-data-handling.md`; it reports, it does not
write. (d) `scripts/coach-injection-canary.ts` takes the provider from `coachProvider()`. Extract
the routing into `lib/ai/route.ts` (pure, tested) rather than growing the adapter. Eval: routing
table tests (non-health → gemini; health + switch unset → refuse; health + switch on + attested →
gemini; never nous), weekly-review persistence test, canary unit test that it writes no file.

**T5.** Add `lib/plan-day-client.ts` `savePlanDay(date, patch)` that writes the legacy store
(`updateDay`) **and** enqueues one complete `plan_days` op (`day_type_override`, `floor_day`,
`swaps`, `slot_notes`; SQL replaces the whole row, so a partial op would erase fields; clearing
sends `day_type_override: null`). Day-type override semantics: from a scheduled rest day, "Training
day" = `training-7-fasted` on Wednesday, `training-10` otherwise; from a training day, "Rest day" =
`rest`. Extract `components/DayTypeSheet.tsx`. MCP `get_day` keeps reading the legacy store —
document it in the PR, do not change it. Eval: pure tests for the override mapping and the
complete-row op payload (including clear → null); protein-unchanged and calorie-target tests via
`resolveTargets`; static render of the chip with the lock glyph.

**T6.** Migration adds `water_goal_cups_training` and `water_goal_cups_rest` (backfilled from
`water_goal_cups`, keep the old column for release A) **and** replaces the `user_settings` branch
of `_sync_upsert` so the full-row write carries both columns; include a down migration. Update
`lib/server/export.ts:449` (emit both goals) and `lib/water-client.ts` (send both). `WaterCard`
takes `dayType` as a prop from `app/page.tsx` (`resolved.dayType`) instead of re-resolving.
Split into a prop-driven `WaterCardView` (static-renderable) and the effectful wrapper. The goal
marker's pulse uses `DESIGN.md` durations and is off under `prefers-reduced-motion`. Eval: pure
oz/goal/marker tests; static render of the view; env-guarded migration test that a settings row
with `water_goal_cups=10` backfills both columns and survives one sync upsert.

**T7.** Keep the matcher local and word-bounded; add false-positive cases ("painting", "not
tired at all" is allowed to match — keep it simple, document). Status change goes through the
same path `MyFoods.tsx:230` uses (legacy store + snapshot sync); say so in the PR. Extract the
decision into pure `noteSuggestsAvoid` and a pure `applyAvoidOffer(food)`; static render of the
offer row.

**T8.** Not ops-only: `scripts/search-eval.ts:20` hardcodes the 85 % gate — change it to 82 % in
the same PR that records the superseding ruling (`docs/decisions/2026-09-12-session-rulings.md`,
superseding `2026-09-11-wave-3-4-rulings.md` line 18) and updates `docs/catalog/relevance.md`.
Production remeasure runs with `--dry-run` so it does not rewrite `lib/search/thresholds.ts`.
Production has zero catalog rows (verified by direct SQL 20:40Z, `catalog_versions` empty). Ops
order: vault URL → preflight (`list_migrations`, disk headroom) → import → post-import counts →
flag on → remeasure → rollback plan = unset the flag; catalog version rollback = the previous
label (none today, so "flag off" is the rollback).

**T9 (stays BLOCK, owner-gated).** Order: T4 lands → Devin confirms billing and prompt-logging
in the AI Studio console (manual attestation, recorded in `docs/ai-data-handling.md` by hand) →
sets `GEMINI_BILLING_ATTESTED=1` → ruling R4 → `COACH_ENABLED`/`NEXT_PUBLIC_COACH_ENABLED` →
smoke a non-health turn and check `ai_calls.provider/model_id`. T2 lands before any capture
flag. Disabled flags are **unset**, never `"0"` (the gates check truthiness).

**T10 (corrected).** Oura's Apple Health export carries sleep and heart rate, not HRV or resting
heart rate, so path A gives sleep and HR only. Path B (register the OAuth app under Sasha's Oura
account) is the verified code path: the existing pull already maps Oura sleep into RHR and HRV
(`lib/oura/map.ts:23`) and fetches readiness. **Recommendation: B.** Even then RHR, HRV and
readiness are stored but dropped by `DailyHealthRow`, the dashboard, MCP and export — T11b adds
them to the roll-up and dashboard; MCP/export follow in T11b as well.

**T11 (Sol second pass, 21:45Z — FIX on all three; these amend T11)**
- Diagnosis corrections: the dashboard reads raw `health_samples` through the TypeScript roll-up
  in `lib/server/health-daily.ts`, not the SQL `daily_health` view; Today already links to
  `/body` from the weight pill (`app/page.tsx:427`); `/api/expenditure` is not flag-gated;
  `/body` renders an empty state when ingest is off. Twenty weigh-ins gate only `WeightTrend`,
  not estimator burn-in.
- **T11a.** Add per-metric provenance to `DailyHealthRow` (`lib/health/contract.ts`,
  `lib/server/health-daily.ts`): for each of steps / active energy / sleep / weight / RHR / HRV,
  the source kind (join `health_sources.kind`) and the latest contributing `end_time`. The Today
  card fetches the **viewed date**. Tab bar: a tri-state capability cache in `sessionStorage`
  (`unknown | enabled | disabled`), set only from an authoritative `200` or `503` on one
  `/api/health/daily` probe; never from cached rows, `401`, or a network error; no probe on
  `/sign-in` (TabBar sits outside `AuthGate`, `app/layout.tsx:39`). Coach is a build-time flag
  (`NEXT_PUBLIC_COACH_ENABLED`) — different mechanism, leave it. `DESIGN.md:195` contracts four
  tab items: with Body (and later Coach) the bar has five or six; update the contract's tab-bar
  section in the same PR and verify the bar at 320 px (labels may drop to glyph-only below
  360 px). Extract `lib/health/today-card.ts` (data hook) and `components/BodyTodayCard.tsx`;
  add only an import and a few lines to `app/page.tsx`.
- **T11b.** Mifflin-St Jeor eval: 70 kg / 165 cm / 30 y / female = **1,420** (±1), not 1,410.
  Katch-McArdle 1,504 and activity 2,050 stand. Define: missing inputs → that line is hidden with
  "Add height, birth year and sex in Settings"; weight input = latest `body_mass` within 14 days,
  else the line is hidden; RHR daily = **minimum** of the day's samples, HRV daily = **mean** of
  the day's samples (document both). Label the activity line "Activity-based (from <source>)"
  since Oura ingestion also yields active energy. Settings read/write of the four new fields goes
  through a typed `lib/body-profile-client.ts` using the existing `user_settings` sync entity,
  with typed contracts (not the generic payload record). Migration: four nullable columns with
  checks (`height_cm numeric`, `birth_year integer`, `sex text check in ('female','male')`,
  `body_fat_pct numeric`); replace `_sync_upsert`'s `user_settings` branch so a payload that
  **omits** a key preserves the stored value and an explicit JSON `null` clears it (a stale phone
  changing its water goal must not erase the body fields — coordinate with T6, which replaces the
  same function: T6 lands first, T11b's migration builds on it). No new RLS policy; add
  cross-user read/update assertions to the RLS tests. Adding RHR/HRV to the SQL `daily_health`
  view is a migration (`create or replace view`, keep `security_invoker`, column order, grants);
  the API roll-up change is code-only — do both. Export: add a typed `body-profile` kind to
  `app/api/export` (the existing settings select at `lib/server/export.ts:269` would not carry the
  new fields); extract a `lib/server/export-body.ts`. `lib/tdee.ts` stays display-only: it is
  never imported by `lib/expenditure.ts`, the proposal job, or target resolution (add a test that
  greps for the import).
- **T11c.** Stage: `HEALTH_INGEST_ENABLED` → `ESTIMATOR_ENABLED` and verify one `/api/jobs/estimate`
  run wrote a row → `NEXT_PUBLIC_ESTIMATOR_UI` and redeploy.
- Order: T6 → T11b (shared `_sync_upsert`); T11a independent of both.

## Model lane note (asked this session)

- **Fixer:** DeepSeek V4.1 Flash via the Codex harness is the lane used for wave 4 and works on
  this repo. Subscription-first would say `agy` (Gemini 3.8 Flash) is free; Devin chose DeepSeek
  for this batch. Both are fine for code.
- **In-app AI:** stay on Gemini (paid tier). DeepSeek's privacy policy stores data in the PRC and
  uses inputs to train by default, which fails the same bar that rejected Nous for health data,
  and DeepSeek has no audio input, so voice capture could not run on it.

## Order and fan-out

Independent, run in parallel: T1, T2, T3, T5, T6, T7. T4 alone touches the adapter. T8 and T9 are
owner-gated ops. Each fix branch is cut from `main`; the auditor reviews each diff against its
ticket and returns PASS / FIX / BLOCK before a PR opens.
