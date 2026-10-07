# TDEE engine plan — make the estimate rival MacroFactor, Carbon and Cronometer

Date: 2026-09-22. Owner: Devin. Ruling: `docs/decisions/2026-09-22-target-priors.md`.
Sources: GPT-5.6 option ranking (`~/Inbox/notes/sasha-tdee-formula-gpt56.md`); competitor and
gap brief (`~/Inbox/notes/sasha-tdee-engines-brief-2026-09-22.md`); architecture §4.3;
`docs/specs/phase-6-estimator.md`.

## Status

| Step | Scope | Status |
|---|---|---|
| A | Per-account prior and BMR into the estimator; retire the 2,130 / 1,372 / 4-day globals | **done** on `feat/ui-edits` (2026-09-22) |
| B | Conservative activity table 1.20–1.70 with whole-day labels; recomp = 0 %; plan-step footer | **done** on `feat/ui-edits` (2026-09-22) |
| C | Body-fat provenance; Mifflin-St Jeor default; Katch-McArdle only for measured values | **landed** in PR #241; migration `20261028090000` in production (checked 2026-10-04) |
| D | Rate-based goals (% body weight / week) on top of the live TDEE | **landed** in PR #241; migration `20261029090000` in production (checked 2026-10-04); Grok + DeepSeek audit done |
| E | Static → adaptive handoff: prior fade, robust 28-day slope, "day fully logged", stricter proposal gate | **built, in review** — spec `docs/specs/phase-16-adaptive-handoff.md`, rulings `docs/decisions/2026-10-04-adaptive-handoff-rulings.md`; PRs #349 (proposal weekdays), #350 (E1 seed freeze), #351 (E6 day mark), engine `exp-3.0.0` (E2–E5, E7–E9) on `feat/tdee-engine-v3`; UI for the mark and the range is the UI lane's |
| F | Test suite: reference personas, derivation properties, adaptive convergence, noise and trust | grows with C–E |

The two done steps also removed the `trainingDays = 4` default from the server path: an account
with no training schedule now derives from its explicit weekdays or is `needs_profile`, never a
silent four.

## Why (one paragraph)

All three commercial apps share one shape: a formula start, then an observed expenditure from
logged intake and weight trend that replaces it. Meal Companion has both halves, and its adaptive
engine (`lib/expenditure.ts`) is specified in more detail than any of the three publish. The gap
is wiring, not maths: the general user lives on the static formula indefinitely, the goal is a
fixed percentage rather than a rate against the live TDEE, and the engine's inputs used to be one
client's constants. Steps C–E close that, in the order that moves accuracy most.

## C — Body-fat provenance (medium)

**C1 done (2026-09-22, `feat/tdee-bodyfat`):** migration `20261028090000_body_fat_provenance.sql`
(two nullable columns, a trigger that clears them when the value changes without a new source,
both keys in `_sync_upsert`); `katchEligible` in `lib/profile/energy.ts`; the rule mirrored
client-side in `withBodyFatProvenance`, applied inside `mutateUserSettings`; the targets route
accepts both fields as optional. Every stored body fat has no source today, so every account
moves to Mifflin until a scan is recorded. Deferred from C: `bmr_method` on the revision and
`birth_date` move to E1 with the other frozen revision fields; the data export does not yet carry
the two columns. Known edge (Grok, 2026-09-22): on a sync conflict the phone's mirror can show
another device's scan label for a new value until the next pull; the server trigger still clears
it, and derivation reads the local Settings, which `settingsWithBodyFatProvenance` guards.
**C2 done:** `components/BodyFatSourceField.tsx` — "Where is this number from?" and a scan date
for DEXA / InBody / clinic — on the onboarding Body step and in Settings › Profile. A source
change goes through the `update_profile` action, so it re-derives targets; a new number clears
the label before the derivation (`settingsWithBodyFatProvenance`), and Undo restores it. The
plan step names the formula `katchEligible` chose. **Deploy order:** the migration must be
applied before this code ships — the server seed selects the new columns.

- Schema: `user_settings.body_fat_source` enum `dexa | inbody | clinical_bia | consumer_scale |
  visual_estimate | typed_unknown`, plus `body_fat_measured_on date`. Migration + `_sync_upsert`
  branch + `lib/sync/user-settings.ts` mapping.
- Rule (`lib/profile/energy.ts` `bmr`): Mifflin-St Jeor by default; Katch-McArdle only when
  source ∈ {dexa, inbody, clinical_bia} and `measured_on` is within 180 days. Record
  `bmr_method` on the target revision (`target_profiles`), so a revision says which formula made it.
- Onboarding Body step: "Where is this number from?" picker under body fat; typed values keep
  their informational display on Body.
- Age from full birth date where present (`birth_date` optional column), else birth year.
- Tests: typed body fat selects Mifflin; recent InBody selects Katch; stale InBody selects
  Mifflin; the persona at verified 32 % → 1,436 × 1.40 = 2,011.

## D — Rate-based goals (medium)

**Ruling (GPT-5.6 `gpt-5.6-sol` xhigh, 2026-09-22; full text `~/Inbox/notes/sasha-tdee-d-rate-goals-gpt56.md`).
Supersedes the earlier draft of this section.**

One pure helper, used by derivation (formula TDEE) and by the weekly proposal (adaptive TDEE):

```ts
tdeeKcal = Math.round(authoritativeTdeeKcal);
rate = goalRateBpWeek / 10_000;
rawAdjustment = 7700 * weightBasisKg * rate / 7;           // 7700 = control coefficient, both ways
adjustment = clamp(rawAdjustment, -0.20 * tdeeKcal, 0.10 * tdeeKcal);
macroMin = 4 * proteinGMin + 9 * fatGMin + 4 * carbGMin;
kcalMin = Math.max(configuredAccountKcalMin ?? 0, macroMin);
targetKcal = Math.max(Math.round(tdeeKcal + adjustment), kcalMin);   // round only the final value
```

- **Rates** (basis points/week, the only accepted values): lose_fat −25 / **−50 default** / −75;
  gain_muscle +10 / **+20 default** / +25; maintain and recomp 0. Sign must match the goal. No
  default varies by sex, age or body-fat provenance. Keep the `lose_fat | recomp | maintain |
  gain_muscle` enum; no second vocabulary.
- **Weight basis:** trend weight when the adaptive engine has one; before handoff the latest valid
  weigh-in, then the onboarding weight. Store the weight and its source; add `"trend"` to
  `TargetWeightSource`. A nonzero adaptive rate with no trend weight → no proposal (replace the
  `weightTrendKg ?? 0` fallback in `lib/proposal.ts`).
- **Floor:** drop the 1,200 / 1,500 kcal sex floors and any BMR-multiple floor.
  `target_profiles.kcal_min = max(explicit account minimum, macro minimum incl. carbs)`; add
  `kcal_min_source` so legacy defaults differ from explicit floors. Never call it a medical limit.
- **Clamp copy:** rate cap — "−0.75%/week exceeds the plan limit. Using 20% below your current
  TDEE: 1,498 kcal/day, about −0.47%/week." Minimum — "Your selected rate would fall below your
  1,430 kcal/day nutrition minimum. Using 1,430 kcal/day; progress may be slower."
- **Protein:** `basisKg = min(weightKg, 30 × heightM²)`; × 2.0 (lose_fat, recomp) or 1.8
  (maintain, gain_muscle). No switch to lean mass when a scan appears or expires.
- **Recomp** = 0 bp but keeps 2.0 g/kg protein (maintain 1.8); fat 25 % with the 50 g floor; carbs
  absorb the difference.
- **One rate, no double counting:** `goalRateBpWeek` required on `TargetInputs` and
  `TargetRevision`, written on every derived / manual / proposal revision and round-tripped by
  restore and Undo (`lib/server/targets.ts` `revisionPayload` and `lib/targets/revision.ts`
  `targetRevisionFromProfile` omit it today, so the DB default 0 wins). Current target kcal is used
  only for the 150 kcal/week transition limit, never as the base of another adjustment.
- Existing accounts stay at 0 bp until the user confirms a rate — no silent backfill.
- Eligibility: automatic rate targets are for healthy adults; pregnancy, minors, eating-disorder
  risk, renal disease and clinician-managed diets get no automatic rate.
- Onboarding Goal step recommends the default rate and the user confirms it.

**Build decisions (2026-09-22, recorded so any can be reversed):**

- `goalRateBpWeek` on `Settings` and `user_settings` is nullable; null = "not confirmed". A null
  derives at maintenance (`energyProfileFrom` → 0) and the revision records `goal_rate_bp_week 0`.
  `deriveTargets` accepts 0 for every goal (the unconfirmed state) and otherwise requires a preset
  for the goal; the targets route rejects a non-preset with 400.
- The one moment a rate is chosen for the user is a **goal change** (`settingsWithGoalRate`): the
  new goal gets its default unless the same write picked a preset. Settings, onboarding and the
  coach's `update_profile` all pass through it; Undo restores the old rate with the old goal.
- Onboarding: `set_goal` pre-selects the default and the user taps Next — that tap is the
  confirmation. An existing loss/gain account that redoes setup has a null rate and
  `missingProfileFields` names "goal rate" until one is picked. Settings shows "Choose a rate"
  with "at maintenance until you choose" for the same account.
- `kcal_min_source`: `macro_minimum` on every derived revision; `legacy_default` (column default)
  on every pre-existing row and on anything written without the key; `account_minimum` is
  reserved (no writer yet). `approve_target_proposal` now copies the source forward and labels its
  weight `trend`.
- `deriveTargets` returns `rate` (`RateOutcome`: tdee, kcalMin, targetKcal, bound, effective
  rate) for the clamp copy; the onboarding plan step and Settings re-run the pure derivation to
  show it. Whole-kcal TDEE is rounded after squashing float noise (1,337.5 × 1.4 → 1,873).
- `lib/proposal.ts` uses the same helper: nonzero rate with a null trend → `none`, "No weight
  trend yet"; the cap and `max(kcal_min, macro minimum)` apply before the 150 kcal step.
- Not changed, for the audit to weigh: `lib/coach/floors.ts` still holds `KCAL_MIN_FLOOR = 1650`
  (the first client's lowest authored day) for coach suggestions; the ruling's account-level
  minimum argues for dropping it. `cachedWeighIn` treats a `trend` weight as no weigh-in (falls
  back to the profile weight), which is correct: a trend is not a weigh-in.

**Audit outcome (Grok 4.6 + DeepSeek, 2026-09-22):** applied — +25 gain preset was labelled
"Slow" (pace now indexed by goal ladder); the targets route accepts a stored 0 on a loss/gain
goal (unconfirmed) instead of a 400 that would block every later profile save; the manual
grams/percent authoring row keeps the active revision's `goal_rate_bp_week` and
`kcal_min_source` instead of zeroing the rate and labelling the row legacy; an off-preset rate
with an unchanged goal keeps the stored rate; onboarding copy "Choose a rate to continue"; grants
restated after each function rewrite; proposal test that `kcal_min` beats the rate under the
150 kcal step. Not applied, with reason: "a cycled day can sit below kcalMin" (impossible —
kcalMin is exactly protein + 50 g fat + 100 g carbs, which every day holds); `:kcal` tagged on
both days when the minimum sets the base (same meaning as before D); anchors "may not match the
installed text" (verified live, each exactly once).

**Open follow-ups from the audit (not in D's scope):** (1) a pre-D loss/gain account derives at
maintenance on its next profile edit or Sunday proposal with no prompt on Today — the ruling's
"no backfill", and there are 0 such accounts in production today, but a one-time "confirm your
rate" invitation on Today or the TDEE card is the right grandfathering, best placed with E9's
card work; (2) `target_profiles.goal_rate_bp_week` has no preset CHECK (user_settings does);
(3) `account_minimum` is a reserved label with no writer; (4) `lib/coach/floors.ts`
`KCAL_MIN_FLOOR = 1650`.

**Locked persona values** (TDEE 1,873, 72.6 kg; loss macro minimum 1,430, gain 1,374 — neither
binds): −25 → 1,673; −50 → 1,498 (capped); −75 → 1,498 (capped); +10 → 1,953; +20 → 2,033;
+25 → 2,060 (capped). Protein basis 72.6 → loss/recomp 145 g, maintain/gain 131 g. Recomp
145 P / 52 F / 206 C, maintain 131 P / 52 F / 220 C before day cycling.

**Tests:** preset lists and defaults; maintain/recomp with a nonzero rate → validation error; the
six persona values; TDEE 1300, 40 kg, −75, macroMin 1170 → 1170, and with account minimum 1250 →
1250; 170 cm 100 kg loss → basis 86.7 kg → 173 g; verified vs unverified body fat → same protein;
weight source weigh-in vs trend; nonzero adaptive rate + null trend → no proposal; −50 bp survives
DB round trip, restore and Undo; changing current kcal with fixed TDEE/weight/rate → same desired
target before the 150 kcal clamp; every output respects the TDEE cap and `kcal_min`.

## E — Static → adaptive handoff (large, own spec)

Spec to write: `docs/specs/phase-9-adaptive-handoff.md`. Contents from the GPT-5.6 ranking and
the gap brief:

1. Persist `initial_tdee_kcal`, `bmr_kcal`, `bmr_method`, `activity_model_version`,
   `derivation_version` on the target revision; the engine reads THESE (step A already passes
   the live profile seed; this freezes it per revision). Bump `ENGINE_VERSION` here, not in A:
   Grok (2026-09-22) noted the per-account BMR clamp changes what a stored row means; the only
   account with rows had a BMR near the old 1,372, so A left the version at `exp-2.0.0`.
2. Days 0–13 formula only, labelled "starting estimate". From day 14 compute a provisional
   expenditure internally, no proposal.
3. Prior fade: `dataWeight = clamp((qualifiedDays − 14) / 28, 0, 1) × intakeQuality ×
   weightQuality`; `tdee = initial + dataWeight × (observed − initial)`. After 42 high-quality
   days the formula has no direct weight.
4. First proposal only when: ≥ 21 explicitly complete intake days, ≥ 12 weigh-ins, ≥ 28 calendar
   days, no recent data-quality hold, and the 14-day and 28-day estimates agree within
   `max(150 kcal, 8 %)`.
5. Weight trend: robust 28-day slope (Theil–Sen) with the 14-day estimate as corroboration; hold
   on disagreement. Test absolute error across every menstrual-cycle phase, not one matched seed;
   the currently accepted 21 % artifact is not competitive.
6. `IntakeDay.userMarkedComplete`: a "day fully logged" mark on Today; nutrient coverage alone
   never qualifies a day. Under-logging is not identifiable from weight and intake alone — say so.
7. Goal changes never move the expenditure estimate. Weekly proposals stay bounded (150 kcal step),
   user-approved, with an easy manual override. No "eat back your workout".
8. Unify the three energy numbers: `lib/tdee.ts` display value must equal the seed when no
   estimate exists and the live estimate afterwards. `formulaTdee` in `lib/tdee.ts` has no
   runtime caller and still picks Katch for any body fat; delete it or route it through
   `katchEligible` here.
9. Show a numeric confidence range on the card, not only low/fair/good. Also render the
   `held` "Finish your profile" reason on the TDEE card (`components/TdeeLines.tsx` shows no
   line for it today; Settings and Body already carry their own "Finish your profile" card).

## F — Tests (grow with each step)

Reference values: Mifflin persona 1,337.5; Katch persona 1,436.35; typed body fat → Mifflin;
recent InBody → Katch; the full activity table locked; recomp = 0; the persona at
{1870, 1956/1760}; birthday and leap-day boundaries.

Properties (fast-check): BMR rises with weight and height, falls with age; Katch falls as body
fat rises at fixed weight; TDEE monotonic across levels; loss ≤ maintenance ≤ gain; recomp =
maintenance; protein invariant across days; weekly macro energy within tolerance for every
`trainingDays` 0–7; no negative macro; Atwater identity; invalid inputs rejected; no silent
four-day default.

Adaptive: flat weight + 2,000 kcal complete intake → ~2,000; known loss and gain rates → expected
energy-balance estimate; a 20–30 % wrong prior converges and is not anchored; goal changes do not
move TDEE; identical observations → identical estimates across accounts; no seed leaks between
accounts.

Noise and trust: a one-day sodium spike makes no proposal; a 1.5 kg three-day swing stays inside
the stated error bound; cycle simulations across every starting phase; 14- vs 28-day disagreement
→ held; missing days → held, never a lower TDEE; a real +250 kcal/day change is detected within
the stated lag; slow ramps track without oscillating proposals; DST and zone changes never move a
day; the 150 kcal proposal step is never exceeded; engine-version changes reproduce old revisions.

## Order and gates

C and D are independent of each other and can land as two PRs after A + B. E needs its spec and
rulings first (weigh-in port, "day fully logged" UI, proposal gate). Every step runs the Grok +
DeepSeek code audit after implementation; numbers changes also go through GPT-5.6 before a PR.
