# Phase 6 — Estimator

Spec for architecture §8 row **6 Estimator**. Authority: `docs/architecture.md` v2.1 (§3.4, §4.3, §5, §9)
and `../analysis/targets.md` for every authored number. Nothing here restates those sections; it names the
files that implement them.

## Goal

Turn 14 days of her real intake and weight into an advisory expenditure number, and turn that number into one
weekly target proposal she approves with a single tap. The engine never writes a target by itself, never
lowers an authored floor, and stays silent until it has earned the right to speak.

## Scope

**In.** `lib/expenditure.ts` (the §4.3 engine, pure); qualified-day and weight-trend definitions; the
`burn_in | held | estimating | blocked` state machine; the three §4.3 acceptance backtests plus the four
F-092 synthetic scenarios; a nightly estimate job and a Sunday weekly-proposal job; a proposal card with
approve / reject; percent target mode (§3.4) end to end, including the floor sequence; the gated weight-trend
line; the two estimator tables, their RLS, and the percent columns on `target_profiles`.

**Out.** Coach access to the estimate (`get_expenditure_status` ships in Phase 7 and reads the same server
function). Health ingest and the `weigh_ins` view (Phase 5). Any automatic target change. Any change to the
ramp table in `lib/targets.ts` — the ramp stays the authored path and outranks the engine. Multi-user coach
approval, per Open question 1. Body-composition or rate-of-change goals beyond `goal_rate_bp_week`.

**Depends on.** Phase 0 (auth, RLS, `target_profiles`, sync, `change_log`), Phase 2 (`daily_totals` and its
coverage fraction), Phase 5 (`weigh_ins` over `health_samples`). Without Phase 5 there are no weigh-ins and
burn-in never ends — see Open question 2.

## User stories

- **Sasha.** She logs and weighs as usual. For the first three weeks the app says only "Learning your
  numbers — 12 of 21 days", with no trend line and no TDEE. When it has enough, Sunday night shows one card:
  "Your training days could go to 2,250 — protein unchanged". She taps **Use these** or **Keep mine**. One
  tap, no arithmetic, no new screen to learn.
- **Devin.** He opens Settings and reads the estimate, its confidence, and why the status is what it is. He
  can switch her targets to percent mode, raise a floor, or set `goal_rate_bp_week`. He can see a proposal the
  engine refused to make (`blocked`) and the floor conflict that caused it.
- **Agent via MCP.** A read-only `get_expenditure_status` tool returns status, `tdee_kcal`, confidence and
  the reason string, so a Codex session can answer "is her TDEE moving?" without a screen. It has no write
  path to targets in this phase.

## Data changes

**Phase 0 already ships `target_profiles` with `mode`, `protein_pct`, `fat_pct`, `carb_pct` and both the
`targets_grams_complete` / `targets_percent_complete` constraints** — architecture §3.4's DDL is written
in grams-and-percent mode from the start (v2.1 changelog #16), and Phase 0's own migration
(`20260911000200_user_schema.sql`, per `phase-0-foundations.md`) creates the table verbatim from that
DDL. Phase 6 adds **no column and no constraint** to `target_profiles`: it only implements the
conversion, validation and floor logic (`lib/targets/percent.ts` below) against the columns Phase 0
already created, and creates the two estimator tables from §3.4. Column definitions live in §3.4 and
are not repeated; the SQL below is what this phase actually runs.

`supabase/migrations/20261006090100_phase6_expenditure.sql` creates `expenditure_estimates` and
`target_proposals` exactly as printed in §3.4, plus one column §3.4 does not carry and the job needs, and the
RLS these tables ship with:

```sql
alter table target_proposals add column week_start date not null;
create unique index target_proposals_one_per_week on target_proposals (user_id, week_start);
create index expenditure_estimates_recent on expenditure_estimates (user_id, local_date desc);

alter table expenditure_estimates enable row level security;
create policy expenditure_estimates_ro on expenditure_estimates for select to authenticated
  using (user_id = (select auth.uid()));

alter table target_proposals enable row level security;
create policy target_proposals_ro on target_proposals for select to authenticated
  using (user_id = (select auth.uid()));
create policy target_proposals_decide on target_proposals for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
```

Both tables are **written only by the privileged boundary** (§2.2): the cron jobs hold the service-role key
through `lib/server/privileged.ts` and pass `p_user_id`. The browser gets `select` on both and `update` on
`target_proposals` only, so an approval cannot invent an estimate. Approval itself runs in one transaction
inside `approve_target_proposal(p_user_id uuid, p_proposal_id uuid)`, a `security definer` function that sets
`status = 'approved'`, inserts the `target_profiles` row with `authored_by = 'engine_proposal'`, and appends
both rows to `change_log` via `next_change_seq` (§3.7). A proposal already decided returns `conflict`.

`supabase/migrations/rollback/20261006090100_phase6_expenditure_down.sql` drops the two tables, the index and
the function. It does not touch `target_profiles` — Phase 0 owns `mode` and the percent columns, and Phase 6
never added them. No user data is lost: a `target_profile` an approval created survives as an ordinary
authored row.

Sync: `target_proposals` and `target_profiles` flow through `change_log` and follow the §3.7 rule — targets
are never merged, the server wins. `expenditure_estimates` is server-computed and pull-only; it is not in the
outbox and has no merge rule.

## API changes

New routes, all `app/api/…/route.ts`. Types live in `lib/api-types.ts`.

```ts
// GET /api/expenditure   — JWT, read-only, returns the latest estimate
type ExpenditureResponse = {
  status: "burn_in" | "held" | "estimating" | "blocked";
  localDate: string;
  tdeeKcal: number | null;          // null in burn_in
  weightTrendKg: number | null;     // null until status leaves burn_in
  confidence: number;               // 0..1
  intakeCompleteness: number;       // qualified days ÷ 14
  qualifiedDays: number;            // last 21
  weighInCount: number;             // last 21
  reason: string | null;            // "3 qualified days in the last 7"
  engineVersion: string;
};

// GET /api/proposals?status=pending — JWT
type ProposalSummary = {
  id: string; weekStart: string; createdAt: string;
  status: "pending" | "approved" | "rejected";
  basedOnEstimateId: string | null;
  proposed: {
    kcalTrain: number; kcalRest: number;
    proteinG: number; fatG: number; carbG: number;
    deltaKcalTrain: number; deltaKcalRest: number;
    raisedToFloor: boolean;          // §3.4 step 5 fired
  };
};

// POST /api/proposals/[id]/decide — JWT, body ≤ 4 KB
type DecideRequest  = { decision: "approve" | "reject"; expectedStatus: "pending" };
type DecideResponse = { status: "approved" | "rejected"; targetProfileId: string | null };

// GET  /api/targets            — JWT, active profile + the grams it resolves to per day type
// POST /api/targets            — JWT, body ≤ 8 KB, authored by the user
type TargetsRequest = { mode: "grams" | "percent"; effectiveFrom: string;
  kcalTrain: number; kcalRest: number;
  grams?: { proteinG: number; fatG: number; carbG: number };
  percent?: { proteinPct: number; fatPct: number; carbPct: number };
  goalRateBpWeek?: number; maxWeeklyKcalStep?: number };
type TargetsResponse = { id: string; mode: "grams" | "percent";
  resolved: { training: Macros; rest: Macros }; raisedToFloor: boolean };

// POST /api/jobs/estimate           — Bearer CRON_SECRET, nightly 03:00 user tz
// POST /api/jobs/weekly-proposal    — Bearer CRON_SECRET, Sunday 21:00 user tz
type JobResponse = { ran: number; skipped: number; errors: number };
```

Error cases, every one a test: `401` no JWT or bad cron secret; `403` a proposal id belonging to another
user (returns `404` in practice, because RLS makes it invisible — assert the 404, not a 403); `409` on
`expectedStatus` mismatch (already approved elsewhere) carrying the current row; `422` on a percent body
whose conversion puts protein or fat under its floor at either day type, with `minProteinPct` /
`minFatPct` in the payload; `422` on percentages that do not sum to 100 after two-decimal rounding; `409`
from a job that finds its per-user-week lock held; `200` with `status:"burn_in"` and null numbers rather
than a 404 when no estimate exists yet.

## Client changes

- `components/EstimatorCard.tsx` — one card on **Settings**, below `RampControl`. In `burn_in` it shows a
  counter and nothing else. In `held` it shows the reason sentence. In `estimating` it shows TDEE, confidence
  as a word (low / fair / good), and the date of the estimate. In `blocked` it shows the floor conflict and
  "Devin decides".
- `components/ProposalCard.tsx` — appears on **Today** while a pending proposal exists. Two buttons ≥44 px:
  **Use these** and **Keep mine**. It states the delta in plain words and that protein does not move.
- `components/TargetModeSheet.tsx` — grams / percent toggle plus three steppers, opened from Settings. In
  percent mode it shows the percentages she entered **and** the grams they produce for a training day and a
  rest day, live, from the same pure function the server uses.
- `components/WeightTrend.tsx` — a sparkline on Settings. Renders only when status has left `burn_in` **and**
  at least 20 weigh-ins exist (F-091). It has no empty state, because it does not mount.
- **Offline.** Estimate and proposal payloads are cached read-only in IndexedDB and render stale with an
  "as of <date>" line. **Approval requires a connection**: offline the two buttons are disabled with "Needs a
  connection". Targets are never merged (§3.7), so an outbox approval could apply against a profile that has
  since changed; this is the one place the app refuses to queue. Local target edits behave the same way.

## Engines and logic

`lib/expenditure.ts` — pure, no I/O, `ENGINE_VERSION = "exp-1.0.0"` written to every estimate row.

```ts
export type WeighIn   = { date: string; kg: number };
export type IntakeDay = { date: string; kcal: number; energyCoverage: number };
export type ExpenditureInput = { asOf: string; weighIns: WeighIn[]; intake: IntakeDay[];
  priorKcal: number; bmrKcal: number };
export type ExpenditureResult = { status: ExpenditureStatus; tdeeKcal: number | null;
  weightTrendKg: number | null; intakeAvgKcal: number | null; intakeCompleteness: number;
  weighInCompleteness: number; qualifiedDays: number; confidence: number;
  reason: string | null; engineVersion: string };

export function isQualifiedDay(day: IntakeDay): boolean;      // see definition below
export function weightTrend(weighIns: WeighIn[], asOf: string): (number | null)[];
export function estimateExpenditure(input: ExpenditureInput): ExpenditureResult;
```

`isQualifiedDay` is the one term §4.3 uses but does not define. This phase fixes it: a local date is
qualified when `energyCoverage ≥ 0.95` in `daily_totals`, `kcal ≥ 1000`, and the date is not today or later.
The three constants are exported by name (`MIN_ENERGY_COVERAGE`, `MIN_QUALIFIED_KCAL`) so a change is a
deliberate edit with a test, not a tuned magic number. See Open question 3.

Everything else — the EMA, the 2.5 % outlier hold, gap interpolation, the six status conditions, the
confidence formula, and the seven numbered clamp steps in their exact order — is transcribed from §4.3 and
must not be re-derived. Seeds `prior = 2130` and `BMR = 1372` come from `targets.md` §1 and live in
`lib/expenditure.ts` as named constants with a comment pointing at that file.

`lib/targets/percent.ts` — the §3.4 conversion, shared by client and server:

```ts
export function percentToGrams(kcal: number, pct: MacroPercents): GramTargets;
export function applyFloors(kcal: number, grams: GramTargets, floors: MacroFloors):
  { kcal: number; grams: GramTargets; raisedToFloor: boolean };
export function validatePercentProfile(pct: MacroPercents, kcalTrain: number, kcalRest: number,
  floors: MacroFloors): { ok: true } | { ok: false; error: string; minProteinPct: number; minFatPct: number };
```

`lib/proposal.ts` — builds the weekly proposal from an estimate and the active profile:

```ts
export function buildProposal(args: { estimate: ExpenditureResult; active: TargetProfile }):
  | { kind: "proposal"; proposed: ProposedTargets }
  | { kind: "blocked";  reason: string }
  | { kind: "none";     reason: string };
```

`lib/server/expenditure.ts` is the only non-pure piece: it reads `daily_totals` and `weigh_ins` for one
`user_id`, calls the pure engine, and upserts one `expenditure_estimates` row per `(user_id, local_date)`.
The two job routes call it through `lib/server/privileged.ts`.

**Unit conversion happens here, not in the view.** `weigh_ins` (architecture §2.1) returns each
`health_samples` row's stored `value` and `unit` unconverted — it does not normalise to kilograms. A
Phase 0 legacy-backfilled weigh-in is written with `unit='lb'` (`phase-0-foundations.md`'s backfill
mapping), while Phase 5 ingest normalises new samples to `kg` (`lib/health/units.ts`'s canonical-unit
convention). Before building `ExpenditureInput.weighIns: WeighIn[]`, `lib/server/expenditure.ts` runs
every row through `lib/health/units.ts`'s `toCanonical('body_mass', value, unit)` (Phase 5) so a legacy
`lb` row and a Phase 5 `kg` sample enter the pure engine on the same footing — `WeighIn.kg` is always
this converted value, never the raw stored `value`.

`lib/expenditure.fixtures.ts` generates the synthetic series (steady state, water swing, cycle, training
step, ramp, under-logging) used by both the backtests and `scripts/backtest-estimator.ts`, which prints the
scenario table and writes `docs/estimator-backtest-<date>.md` for the Phase 6 exit record.

## Security

Rows this phase adds to the §5 endpoint matrix:

| Route | Identity | Body limit | Rate limit | Idempotency | Notes |
|---|---|---|---|---|---|
| `/api/expenditure` | Supabase JWT | — | 60/min/user | — | RLS read (§2.1); no numbers in `burn_in` |
| `/api/targets` GET / POST | JWT | 8 KB | 30/min/user | — | floors validated server-side; a body may not lower a floor |
| `/api/proposals` | JWT | — | 60/min/user | — | RLS read |
| `/api/proposals/[id]/decide` | JWT | 4 KB | 30/min/user | `expectedStatus` CAS | one transaction via `approve_target_proposal` |
| `/api/jobs/estimate` | `Bearer $CRON_SECRET` | — | — | one row per user/day | privileged boundary (§2.2); Vercel cron |
| `/api/jobs/weekly-proposal` | `Bearer $CRON_SECRET` | — | — | per user/week unique index + advisory lock | privileged boundary (§2.2) |

The jobs are the first §2.2 callers in this phase: they resolve each `user_id` from a query the wrapper
scopes, never from a request body, and the service-role key stays inside `lib/server/admin.ts`. `POST
/api/targets` re-applies the floor sequence server-side even when the client already did — the client copy is
for display, not for authority.

## Test plan

**Unit (new files).**
`lib/expenditure.test.ts` — EMA seeding from the first three weigh-ins; a 3-day gap interpolates and a 4-day
gap leaves the trend undefined; a weigh-in 2.6 % off trend is held out and one at 2.4 % is not; the seven
clamp steps applied in order, each asserted on its own; `prior ± 10 %` clamp; the `0.9 × BMR … 2.2 × BMR`
bound at 1,235 and 3,018; rounding to 10 kcal; `prior` for the next run equals the stored value; the
confidence formula on hand-worked inputs; every branch of the status machine, including "21 calendar days but
14 qualified days stays `burn_in`".
`lib/targets/percent.test.ts` — conversion at both day types; carbs as the remainder reconstructing kcal
within ±10; floors applied in grams after conversion; the floor-conflict case raising kcal instead of cutting
protein; rejection with the minimum percentage named; the sum-to-100 constraint at two decimals.
`lib/proposal.test.ts` — protein never moves; `|Δkcal| ≤ max_weekly_kcal_step`; the training/rest ratio is
preserved; `kcal ≥ kcal_min`; a required raise above the step cap returns `blocked`.
`lib/expenditure.backtest.test.ts` — the three §4.3 acceptance claims, each its own test: artifacts bounded
(1.5 kg water swing over 3 days, ±0.8 kg on a 28-day cycle → TDEE moves ≤ 5 %, status unchanged);
under-logging holds (3 qualified days in a week → `held`, no proposal, no lowered TDEE); real change detected
(+250 kcal/day step reflected within ±100 kcal inside 21 days; a +15 kcal/day/week ramp tracked under 120 kcal
error). F-092's blanket "under 5 % on every scenario" is superseded by these three claims per the v2.1
changelog, row 15; the older wording is not the gate.

**Integration.**
`app/api/jobs/weekly-proposal/route.test.ts` — running the job twice for one user-week creates one proposal;
a `held` user gets none; a `blocked` user gets a blocked estimate and no proposal.
`app/api/proposals/decide.route.test.ts` — approve writes exactly one `target_profiles` row and two
`change_log` rows in one transaction; a second approve returns 409 with the current row; reject writes no
profile; another user's proposal id returns 404; an approved proposal changes what `GET /api/targets`
returns and nothing else.
`app/api/targets/route.test.ts` — percent round trip; a body with fat below the floor is rejected 422 with
`minFatPct`; the server recomputes floors even when the client sent post-floor numbers.
Cross-user denial on both new tables and the new function, added to the Phase 0 suite (§9).

**Manual gate (Devin, on the phone).** With Sasha's real account after 21 qualified days: open Settings and
read the estimate and its reason; confirm no trend line appeared before burn-in ended; trigger the Sunday job
out of band; see the proposal card on Today; put the phone in airplane mode and confirm the buttons disable
with "Needs a connection"; come back online and tap **Use these**; confirm the new targets show on Today,
protein is unchanged from the ramp value, and the card is gone. Then approve nothing for a week and confirm
the second Sunday replaces the pending card rather than stacking a second one.

## Acceptance criteria

1. With fewer than 21 qualified days, `GET /api/expenditure` returns `status:"burn_in"`, `tdeeKcal:null`,
   `weightTrendKg:null`, and no screen renders a trend line or a TDEE number.
2. Elapsed calendar time alone never ends burn-in: a 60-day account with 14 qualified days stays `burn_in`.
3. `WeightTrend` does not mount until status has left `burn_in` **and** at least 20 weigh-ins exist.
4. The three §4.3 backtests pass at the stated bounds, and `scripts/backtest-estimator.ts` writes the
   scenario table committed as the exit record.
5. Running `/api/jobs/weekly-proposal` twice for the same user and week produces exactly one proposal row.
6. A proposal never changes a displayed target until it is approved; `GET /api/targets` before approval
   returns the previous profile.
7. Approving writes one `target_profiles` row with `authored_by:"engine_proposal"` and appends to
   `change_log`; approving the same proposal twice returns 409 and writes nothing.
8. No proposal moves protein from its authored ramp value, and none puts fat below 50 g or kcal below 1,650.
9. A proposal that would need a calorie rise above `max_weekly_kcal_step` to satisfy a floor produces
   `status:"blocked"` and no proposal row.
10. A percent profile round-trips: the grams it produces reconstruct `kcal_train` and `kcal_rest` within
    ±10 kcal at each day type, and switching grams → percent → grams preserves the effective split.
11. A percent body whose conversion puts protein or fat under its floor is rejected 422 and the message names
    the minimum percentage that satisfies the floor.
12. Every engine output row carries `engine_version`, and a change to any constant in `lib/expenditure.ts`
    fails at least one unit test.
13. Cross-user denial tests pass on `expenditure_estimates`, `target_proposals` and
    `approve_target_proposal`; a browser JWT cannot insert or update an estimate.
14. Offline, the proposal card renders from cache with an "as of" date and both buttons are disabled.

## Rollout and rollback

Ship behind `ESTIMATOR_ENABLED` (server) and `NEXT_PUBLIC_ESTIMATOR_UI` (client), both off at deploy. Order:
migrations → jobs enabled with the UI still off, so estimates accumulate and Devin can read them through
`/api/expenditure` for a week → percent mode on → proposal card on. The nightly job is harmless with the UI
off; it writes only `expenditure_estimates`.

Rollback has three levels. Turn off `NEXT_PUBLIC_ESTIMATOR_UI` to hide everything with the data intact.
Remove the two cron entries in `vercel.json` to stop new estimates. Run the `rollback/` migration to drop the
two estimator tables and the function — `target_profiles` and its percent columns are Phase 0's and are
untouched; approved profiles survive as authored rows, so her targets do not move. A bad engine change is
reverted by `ENGINE_VERSION`: estimates carry the version that produced
them, so a wrong series is identifiable and deletable by version without touching approved targets.

## Reference implementation
fud-ai (MIT): its Adaptive Goals are LLM-proposed from an evidence packet — do NOT lift the mechanism (ours is deterministic); DO lift the macro pinning / auto-balance-remainder model for percent targets and the GoalEvidence day-coverage + confidence shape for `reason`. BMR/TDEE (Katch-McArdle when body fat known, else Mifflin-St Jeor; 7700 kcal/kg) converges with ours. Full review with file paths and excerpts: `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`. Any ported code carries the MIT attribution line in `NOTICE.md`.

## Open questions

1. **Who may approve.** §4.3 says "a tap from Sasha or Devin", but §2.1 RLS confines every row to
   `auth.uid()`, so Devin cannot see her proposal. This phase ships **Sasha-only approval** and leaves
   `decided_by` populated with her id. A coach role needs a grant model that does not exist yet — Phase 7 or
   a separate decision. Confirm before build. **Closed 2026-09-12: ruling 4** in
   `docs/decisions/2026-09-12-wave4-rulings.md` — Sasha-only is final; no Devin grant model this wave.
2. **Manual weigh-ins — resolved, no change needed.** `phase-0-foundations.md`'s own scope already adds
   `'manual'` to the `health_sources.kind` check ("Additions to v2.1 this phase makes") and its legacy
   backfill writes body-mass samples through a `health_sources` row `kind='manual'`. `weigh_ins` sees
   these rows from Phase 0 onward, so burn-in can complete with no Apple Health or Oura connected. The
   stale recommendation to add `'manual'` in Phase 5 is withdrawn — Phase 0 already owns it.
3. **Qualified-day thresholds.** `energyCoverage ≥ 0.95` and `kcal ≥ 1000` are this spec's proposal, not
   architecture's. They decide how often she reaches `estimating`. Devin confirms or replaces them before the
   backtests are treated as calibrated. **Closed 2026-09-12: ruling 5** — confirmed as contract values; not
   retuned to move the artefact backtest.
4. **`goal_rate_bp_week` default.** `targets.md` §2 is a recomposition plan at maintenance, so 0 is the
   right default, but nothing states who may change it or whether Sasha sees the control at all. Assumed
   Devin-only in Settings.
5. **`kcal_min`.** §10 leaves 1,650 open for Devin to re-author before this phase. If he changes it, the
   constant moves in `lib/targets/percent.ts` and criterion 8 changes with it. **Closed 2026-09-12: ruling 5**
   — confirmed at 1650; the SQL default is unchanged.
6. **Second pending proposal.** The unique index is per user and week, so the second Sunday writes a new row
   while the first is still pending. This spec renders only the newest and auto-rejects the older one on
   write. Confirm that is what he wants over letting them stack. **Closed 2026-09-12: ruling 7** — the newer
   proposal replaces the older one, enforced by a partial unique index plus a one-transaction RPC.
