# Phase 16 — Static → adaptive TDEE handoff (TDEE plan step E)

Date: 2026-10-04. Owner: Devin. Plan: `docs/plans/2026-09-22-tdee-engine-plan.md` §E.
Sources: GPT-5.6 ranking (`~/Inbox/notes/sasha-tdee-formula-gpt56.md`), the gap brief
(`~/Inbox/notes/sasha-tdee-engines-brief-2026-09-22.md`), ruling
`docs/decisions/2026-09-22-target-priors.md`, `docs/specs/phase-6-estimator.md`.
Rulings for the open calls in this spec: `docs/decisions/2026-10-04-adaptive-handoff-rulings.md`.

This spec is also the PRD for the autonomous build of step E: §Acceptance is the done list.

## Goal

Every account starts from its own formula TDEE and moves, on evidence, to a TDEE learned from its own
complete intake days and weight trend. The handoff is gradual, explained, and never chases bad data.
The user sees one number with a range, and a proposal only when the evidence is strong.

## Today (main `6877f51` + PR #349)

- `lib/expenditure.ts` `exp-2.0.0`: a 20-day EMA weight trend; `tdee_raw` from a 14-day endpoint delta;
  each run clamps to ±10 % of the **last stored value** and blends by confidence. The prior walks from
  the profile seed. Nothing anchors the estimate to the formula, and nothing lets go of it on schedule.
- Burn-in returns no number (`tdeeKcal: null`) for the first 21 qualified days.
- A day qualifies on `energy_kcal` coverage ≥ 0.95 and ≥ 1,000 kcal. Coverage proves the logged foods
  have calorie data, not that the person logged everything they ate.
- The seed is re-derived from the **live** profile on every run, so a profile edit silently changes
  what old estimates meant.
- `estimating` alone makes the Sunday job propose.

## Scope

**In (backend lane):** E1 frozen seed on the revision; E2–E5 engine v3 (phases, prior fade, robust
slope, corroboration, proposal gate); E6 the `day_complete_at` mark (schema, sync, engine input);
E7 goal-independence test; E8 one energy number; E9 numeric range in the API. The F test suite for all
of the above.

**In (UI lane, asked through the UI session):** the "Day fully logged" control on Today; the range and
the `held` reason on the TDEE card (`components/TdeeLines.tsx`); "starting estimate" copy.

**Out:** device calories (never added); any automatic target change; menstrual-phase modelling beyond
tests; a new goal vocabulary.

## Design

### E1 — Freeze the seed on each target revision

New nullable columns on `target_profiles`: `initial_tdee_kcal integer`, `bmr_kcal integer`,
`bmr_method text check (bmr_method in ('mifflin','katch'))`, `activity_model_version text`,
`derivation_version text`. Every derived revision writes them from `lib/profile/energy.ts`. Manual
authoring, proposal approval, restore and Undo copy them forward from the revision they replace
(the `goal_rate_bp_week` threading in PR #241 is the template). The estimator reads the seed from the
**active revision**; a revision without the columns (every row before this phase) falls back to the
live profile seed, and the result says which (`seedSource: "revision" | "live_profile"`).

### E2 — Phases

`phase` is added to the result; `status` keeps its four values so no consumer breaks. Measurement
(`status`) and proposal eligibility (`proposalEligible`, E4) are separate (ruling R4).

| Phase | When | `tdeeKcal` | `status` |
|---|---|---|---|
| `starting` | < 14 qualified days (lifetime), or no valid observation yet | null (the card shows `profileTdeeKcal`, the frozen seed) | `burn_in` |
| `provisional` | ≥ 14 qualified days and a valid 14-day observation, 28-day not yet valid | faded value from the 14-day observation | `burn_in` |
| `adaptive` | valid 28-day observation | faded value from the 28-day observation | `estimating` |
| any | the observation the phase needs is invalid after it was once valid | most recent valid estimate from the last 28 days, else the seed (R8) | `held` |

`tdeeKcal` stays null while `starting`, so `components/TdeeLines.tsx` keeps rendering "From your
profile" without a UI change. `profileTdeeKcal` in `GET /api/expenditure` becomes the frozen seed
(E1), the one starting number every surface shows (E8).

### E3 — Prior fade (replaces the ±10 % walk and the confidence blend)

```ts
dataWeight = clamp((lifetimeQualified - 14) / 28, 0, 1);   // quality gates, never multiplies (R2)
tdee = seed + dataWeight * (observed - seed);              // observed = obs28 if valid, else obs14
```

After 42 qualified days the formula has no direct weight. The engine is stateless: every number is
recomputed from the inputs each night, so one bad night cannot drift the next. `priorFor` is retired.
Outside 0.9–2.2 × BMR the value is clamped and flagged, never presented as learned (R5).

### E4 — Proposal eligibility (`proposalEligible`)

All of (ruling R4): a valid 28-day observation; ≥ 21 qualified days in the last 28; ≥ 28 calendar days
since the first qualified day; `|obs14 − obs28| ≤ max(150, 8 % × obs28)`; no data-quality hold on any
of the 7 preceding calendar days (recomputed from the inputs); half-width ≤ `max(200, 10 % × tdee)`;
no review flag. `buildProposal` additionally needs a weekly-average move of ≥ 75 kcal/day.

### E5 — Observations

```ts
obsN = meanKcal(qualified days in last N) - theilSenSlopeKgPerDay(weigh-ins in last N) * 7700;
```

- Theil–Sen over one reading per day (the day's median): the median of pairwise slopes.
- Validity (R1): 14-day — ≥ 10 qualified days, ≥ 6 weigh-in days spanning ≥ 11 days; 28-day — ≥ 14
  qualified days, ≥ 12 weigh-in days spanning ≥ 24 days and ≥ 2 readings in each 7-day block. Both
  need a reading within 2 days of `asOf`.
- `weightTrendKg` = the Theil–Sen line of the window in use, evaluated at the last complete day.
- **Review flag (R5):** `|obs28 − seed| > 35 % × seed` pauses proposals and says "Your logged intake
  and weight don't fit together — check that every day counted is complete"; it releases after 14
  consecutive days of valid, agreeing observations. The estimate still fades.
- **Steps (R7):** `activityContext` passes through for context; it never selects an observation.

### E6 — "Day fully logged"

- `plan_days.day_complete_at timestamptz null`, synced like the other `plan_days` fields
  (`_sync_upsert`, `lib/sync/plan-days*.ts`, merge, export). Set by the user on Today; cleared by
  un-marking. The server never sets it.
- `IntakeDay.userMarkedComplete: boolean` from that column.
- **Qualification (ruling R3):** a day qualifies when it is before `asOf`, has ≥ 1,000 kcal, and
  either is marked complete or falls before `user_settings.day_marks_started_on` with energy coverage
  ≥ 0.95. `day_marks_started_on` is set by a trigger on the first mark and never moves later, so
  clearing a mark cannot restore the old rule. An account that never marks keeps coverage days.

### E7 — Goal changes never move the estimate

The engine reads no goal field. A test changes goal and rate with identical observations and asserts
an identical estimate.

### E8 — One energy number

`lib/tdee.ts` display value equals the frozen seed when no estimate exists and the engine's `tdeeKcal`
afterwards. `formulaTdee` (no runtime caller, picks Katch for any body fat) is deleted.

### E9 — Range

`tdeeLowKcal` / `tdeeHighKcal` on the result, the estimate table and `GET /api/expenditure`. An
empirical variation band, not a confidence interval (R6):

```ts
halfWidth = max(150, (1 - w) * 0.15 * seed, |obs14 - obs28|, max_k |obs28(t) - obs28(t-k)|);  // k = 1..14, valid days only
```

Terms whose observation does not exist are omitted; rounded to 10 kcal. Persona day 0: 1,590–2,150.
The card shows "about 2,050 (1,900–2,200)". Rendering is the UI lane's.

### Versioning

`ENGINE_VERSION = "exp-3.0.0"`. A stored row keeps its version; old rows are not recomputed.

## Data changes

1. Migration `…_target_seed_freeze.sql`: the five `target_profiles` columns; every SQL writer that
   inserts a revision copies them forward (`approve_target_proposal`,
   `write_target_revision_if_active`, …).
2. Migration `…_expenditure_v3.sql`: `expenditure_estimates` gains `phase text`, `tdee_low_kcal`,
   `tdee_high_kcal`, `data_weight numeric`, `seed_source text`, `proposal_eligible boolean`,
   `review_flag text` (all nullable; old rows stay null).
3. Migration `…_plan_days_day_complete.sql`: `plan_days.day_complete_at` + the `_sync_upsert` branch,
   and `user_settings.day_marks_started_on` with its trigger (R3).

All three are additive and nullable. Each goes to production before the PR that reads it merges.

## API changes

`GET /api/expenditure` adds `phase`, `tdeeLowKcal`, `tdeeHighKcal`, `dataWeight`, `seedSource`.
Additive; existing fields keep their meaning except that `tdeeKcal` is no longer null in `burn_in` when a
seed exists. MCP `get_expenditure_status` adds the same fields.

## Acceptance (the done list)

1. Persona (R4 of the 2026-09-22 ruling): day 0 → `starting`, `profileTdeeKcal` 1,873, range 1,590–2,150.
2. Flat weight + 2,000 kcal complete intake from a 1,873 seed: by day 42 the data weight is 1, the
   estimate equals the 28-day observation (not anchored), and it is within 80 kcal of 2,000. The
   80 kcal is the fixtures' own noise (±120 kcal intake, ±0.25 kg scale), measured, not tuned.
3. A seed 25 % wrong in either direction is within 80 kcal of truth by day 50; not anchored
   (the review flag may pause proposals but never the estimate).
4. Known loss of 0.5 kg/week at 1,800 kcal intake → 2,350 ± 60 at day 42.
5. A three-day +1.5 kg water swing → no proposal on its account; estimate moves < 60 kcal.
6. Menstrual-cycle simulation (±1.2 kg, 28-day period) at every starting phase → no proposal of
   opposite sign within 28 days, and the day-42 range contains the truth.
7. 14/28 disagreement beyond threshold → `proposalEligible` false with its reason.
8. Too few qualified days → `held` with the last valid estimate, never a lower one.
9. After `day_marks_started_on`, coverage-complete but unmarked days do not qualify; before it they do.
10. Goal and rate changes do not change the estimate.
11. A genuine +250 kcal/day change moves the estimate ≥ 200 within 28 days.
12. A slow ramp never yields opposite-sign proposals within 28 days.
13. Days are the logged ISO local dates; nothing re-derives them from a zone.
14. Revision seed round trip: derive → approve → restore → manual pin keeps all five columns.
15. Old rows keep their `engine_version`; no recompute.
16. `formulaTdee` gone; the display TDEE equals the engine's number.
17. Lint, typecheck, `pnpm test` once; DB tests pass on a local stack.

## Delivery

| PR | Contents | Depends on |
|---|---|---|
| E-a | E1 migration + threading + estimator reads frozen seed | migration 1 in production |
| E-b | Engine v3 (E2–E5, E7, E9) pure + tests; server wiring; estimate table columns; API | migration 2 |
| E-c | E6 column + sync + engine input | migration 3; UI control from the UI lane |
| E-d | E8 cleanup | E-b |

Each numbers change gets a GPT-6 Sol review before its PR (it replaced GPT-5.6 in the lane table). The
spec review ran on 2026-10-04; rulings R1–R9 in `docs/decisions/2026-10-04-adaptive-handoff-rulings.md`.

## Fluid cycles (exp-3.1.0, ruling R10)

exp-3.0.0 measured a ±20 % swing on a 28-day fluid cycle. exp-3.1.0 fits a line plus a sinusoid
(period 24–35 days) over the last 56 days when the evidence is strong, and uses the line's slope;
otherwise nothing changes. From day 42 the estimate stays within 50 kcal of truth on every tested
cycle; until 38 days of weigh-ins exist the data weight is capped at 0.5 and no proposal is made.
`fluidCycleDays` on the result and the API names the period, so the card can say why the number
holds steady while the scale swings.

## Where Jev could help (not in this build)

A `day_completeness` judgment: given the slots and entries logged today, the probability the day is
fully logged. Use it only as a nudge before the user marks a day ("No dinner logged — mark anyway?"),
never as a qualification rule; the estimator stays deterministic. Details in
`docs/plans/2026-10-04-jev-opportunities.md`.
