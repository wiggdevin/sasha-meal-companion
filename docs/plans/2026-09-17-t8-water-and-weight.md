# T8 — Water and weight — 2026-09-17

Program: `docs/plans/2026-09-17-fab-coach-program.md` (T8, decision D3). Size S.
Coder: Opus 5. Panel holds AC1–AC7 outside the repo. Adversary: Grok 4.6.
Runs in parallel with T0 on its own branch `feat/t8-water-and-weight`, from `main` at fa81313.

## Why

Two things she does every day go nowhere she can see.

- **Water.** The FAB logs a cup (`addCups`, `lib/water-client.ts:39`) and the row syncs
  (`water_log` is a synced entity). Nothing on Today shows the count. `components/WaterCard.tsx`
  is a full card that is unit-tested and mounted nowhere. D3 chose one line in the progress card,
  not a card.
- **Morning weight.** The FAB's "Morning weight" input writes `weightLb` into the legacy
  per-device store (`lib/store.ts:199`). The header pill (`app/page.tsx:367-416`) reads only the
  ingest value from `daily_health`, so a typed weight never shows in the pill, and it never reaches
  `health_samples`, so the expenditure estimator (which reads the `weigh_ins` view over
  `health_samples` where `type = 'body_mass'`) never sees it.

The program's "apply the two pending migrations to production" is already done: every migration on
`main` is applied to production as of the T1 landing on 2026-09-17. No production migration step
belongs to T8 unless T8 adds one (it does, §2).

## Design

### 1. Water: one line in the progress card

- `components/MacroRings.tsx` (the compact progress card) gains an optional prop
  `water?: { cups: number; goal: number }`. When present it renders one more footer line under
  "Still to eat", same typography and rhythm:

  `Water <cups> of <goal> cups` — and when `cups >= goal`: `Water <cups> of <goal> cups · done`.

  No meter, no stepper, no emoji. The line is a plain `<span>`; the whole card stays one tap target
  as today. Coach voice: short, plain, no exclamation marks.
- `app/page.tsx` reads `getWater(viewedDate)` (`lib/water-client.ts`) alongside the other
  per-day reads, passes `{ cups, goal }` to `MacroRings`, and re-reads after `logWater()` so the
  line updates in the same render pass as the FAB action (optimistic: the IDB row is written
  before the outbox posts, so the count is already local).
- `goal` is `goalFor(dayType, settings)` (`lib/water.ts`) for the viewed day — the training/rest
  goal, never the legacy single goal when a per-day-type goal exists.
- `components/WaterCard.tsx` and `tests/water/water-card.test.tsx` are removed. The card was never
  mounted; the line replaces it. `lib/water.ts` and `lib/water-client.ts` stay as they are.
- Offline: the line reads from IDB, so it renders with no network. A day with no `water_log` row
  shows `Water 0 of <goal> cups`.

### 2. Morning weight: one row she owns, one pill that shows it

**Storage.** A typed weigh-in becomes a `health_samples` row: `type = 'body_mass'`, `unit = 'kg'`,
`value` = the typed pounds converted to kg (`lbToKg`, 3 decimals), `source_id` = her `manual`
source (`health_sources.kind = 'manual'`, created on first use), `start_time = end_time` = 07:00
local on the day she typed it for, `tz` = her IANA zone, `vendor_sample_id = 'manual:<local_date>'`.
One manual row per user per local day: typing again for the same day **replaces** the value (the
same `vendor_sample_id` under the same source is the natural key the dedupe already uses).

**Write path.** RLS revokes insert on `health_samples` from `authenticated`; writes go through
security-definer RPCs. T8 adds one migration `supabase/migrations/<ts>_manual_weigh_in.sql`
(+ `.down.sql`) defining `health_weigh_in(p_local_date date, p_tz text, p_kg numeric)`:
`security definer`, scoped to `auth.uid()`, granted to `authenticated`; it upserts the caller's
`manual` source row and upserts the sample as above. It refuses `p_kg` outside 20–400 and a date
more than 1 day in the future (raise, mapped to 422). It returns the sample id and the stored kg.

The client calls it from a new `POST /api/health/weigh-in` route (JWT, zod body
`{ localDate, tz, lb }`, 8 KB, rate-limited like the other log routes), which calls the RPC with
the user's client (not the admin client). Response `{ kg, sampleId }`.

**Local first, then server, never lost.** `logWeight(lb)` in `app/page.tsx` keeps writing
`updateDay(viewedDate, { weightLb })` first (instant, offline-safe, what the weekly summary already
reads), then calls the route. If the route fails (offline, 5xx) the day is left in a small
`pending weigh-ins` list in the same IDB store the outbox uses, and `components/SyncBootstrap.tsx`
drains it after every successful sync — the same pattern T1 used for `backfillFoodPrefs`
(`lib/foods/prefs-client.ts`): bounded batch, in-flight guard per user, failed ids retried next
run, nothing re-posted once the server has answered 2xx. A 422 is not retried; the FAB copy shows
the server's message.

**Header pill precedence.** For the viewed day (amended after the Grok review of round 1 — the
original list collapsed the local value and the synced manual sample into one step, which froze the
pill on the last SYNCED number):

1. an ingest sample (any `health_sources.kind` other than `manual`) for that day → show it;
2. else the `weightLb` typed on this device for that day → show it;
3. else her manual sample for that day, from `daily_health` → show it;
4. else no pill, as today.

Rule 2 sits above rule 3 because the synced manual sample is a COPY of something she typed, and the
copy is never newer than the original: typing writes the local store first and only then posts. With
them the other way round, correcting 170 to 171 left the pill saying 170 until the next health fetch.

`lib/server/health-daily.ts:mergedDays` and the `daily_health` view must implement rule 1 over
rule 3 — an ingest value for the day wins even when the manual row is newer. The pill's text and
link (`/body`) do not change.

**Estimator.** No change: the `weigh_ins` view already reads every `body_mass` sample. The panel
proves a manual row is picked up (AC6).

### 3. Docs

`docs/features.md`: F-028 unchanged; F-032 says the typed weight is stored as a `health_samples`
row and shown in the pill; F-065 becomes `exists` (water is on `water_log` and shown on Today).
`docs/architecture.md`: the health section gains the manual weigh-in path and the precedence rule.
`AGENTS.md` module table if it lists `WaterCard`.

## Out of scope

Weight trend smoothing (F-084), the `/body` page, water goal editing (it stays in Settings),
any change to the FAB itself, any change to `lib/store.ts` beyond what §2 needs.

## Acceptance criteria (the panel's, hidden from the coder)

- **AC1** With `water_log` rows for the day and a training-day goal of 10, the Today progress card
  renders exactly one line `Water 3 of 10 cups`; with 10 cups it reads `Water 10 of 10 cups · done`;
  with no row, `Water 0 of 10 cups`. The card renders no meter, stepper or second water element.
- **AC2** `WaterCard` is gone from the repo and nothing imports it; `pnpm tsc` is clean.
- **AC3** A typed `170` lb for `2026-09-17` produces one `health_samples` row: `body_mass`, `kg`,
  `77.111`, manual source, `vendor_sample_id = 'manual:2026-09-17'`, `start_time` 07:00 in her
  zone. Typing `171` for the same day leaves one row with `77.564`. Typing for another user's
  id, or 10 lb, or a date two days ahead, is refused with 422 and writes nothing.
- **AC4** With the route failing, the local `weightLb` is written at once, the day lands in the
  pending list, and after the next successful sync the row exists on the server and the pending
  list is empty; a second sync posts nothing.
- **AC5** Pill precedence: day with an Oura sample 80.0 and a manual 77.1 shows 176.4 lb; day with
  only manual shows 170.0 lb; day with neither shows no pill.
- **AC6** After AC3's row exists, `weighInsKg` for the estimator returns it.
- **AC7** No regression: `pnpm test` once green, tsc, lint, design lint. Files touched stay under
  400 lines.

## Proof folder — `~/Desktop/proof/t8-water-and-weight/`

`acceptance-criteria.md`, `AC1..AC7.txt`, `grok-review.md`, `production-evidence.md` (migration
applied, deploy sha, one phone screenshot of the water line, one of the pill after a typed weight
on the local stack).
