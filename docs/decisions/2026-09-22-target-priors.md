# Ruling 2026-09-22 — target priors are per account, and conservative

Owner: Devin. Branch: `feat/ui-edits`. Reviews: GPT-5.6 (`gpt-5.6-sol`, xhigh) ranked the options;
Grok 4.6 and DeepSeek audited the diff. Evidence: `~/Inbox/notes/sasha-tdee-formula-gpt56.md`,
`~/Inbox/notes/sasha-tdee-engines-brief-2026-09-22.md`.

## What was wrong

Numbers fitted to one early account had become every account's defaults. This is a
**specification defect**, not an implementation bug: the code did exactly what plan row D2 said,
and D2 was tuned to one person (activity factor 1.55). Three instances:

1. `lib/profile/energy.ts` mapped "moderate" to 1.55 for everyone. For a 58-year-old, 160 lb
   woman with typed 32 % body fat that produced 2,215 / 1,983 kcal (2,115 average).
2. `lib/server/expenditure.ts` seeded every account's expenditure walk at `PRIOR_KCAL = 2130`
   and clamped every estimate to a band around `BMR_KCAL = 1372` — two hard-coded
   constants clamping everyone's learned TDEE.
3. "Recomp" was an undisclosed −5 % deficit while its copy promised weight maintenance.

## Rulings

- **R1. Activity factors are conservative priors:** sedentary 1.20, light 1.30, moderate 1.40,
  active 1.55, very active 1.70. Labels describe the whole day (sitting/walking AND sessions per
  week). The expenditure engine is meant to replace these numbers, so they err low.
- **R2. Recomp is 0 %** (weight-maintaining). lose_fat −20 %, maintain 0, gain_muscle +10 % stay.
- **R3. The expenditure engine takes its prior and its BMR clamp from the account's own profile**
  (`lib/server/profile-tdee.ts` → `profileSeedFor`). An account with no complete profile gets a
  `held` row with reason "Finish your profile — the estimate starts from your own numbers" and
  no number. The two constants live only in `lib/expenditure.fixtures.ts`, for test scenarios.
- **R4. Reference persona.** Female, 1968, 170 cm, 72.6 kg, no verified body fat, moderate,
  recomp → Mifflin 1,337.5 × 1.40 = 1,873; training 1,956 / rest 1,760; 145 g protein, 52 g fat.
  Locked by `lib/profile/energy.test.ts`.
- **R5. `analysis/targets.md` stays the authority for the first client's numbers only.** It is
  not a source of defaults for any other account. Plan row D2 is superseded by this ruling.

## Not changed here (steps C–F, `docs/plans/2026-09-22-tdee-engine-plan.md`)

Body-fat provenance (Katch-McArdle only for measured values), rate-based goals, the static →
adaptive handoff (prior fade, robust 28-day slope, "day fully logged", stricter proposal gate),
and the property/convergence test suite.

## Superseded text

`lib/tdee.ts`'s header and `lib/server/profile-tdee.ts`'s old header said body-profile fields
never enter the estimator. They now enter it as the seed, on purpose; `lib/tdee.ts` itself (the
Body screen's display estimate) is still kept off the target path by `lib/tdee.test.ts`.
