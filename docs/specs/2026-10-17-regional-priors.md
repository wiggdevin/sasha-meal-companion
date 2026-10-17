# Regional priors — ACS re-weighting, CE Diary lift, Canada CCHS (docs only)

Date: 2026-10-17. Status: spec only; nothing here is built and no code reads it. Parent:
`docs/specs/phase-18-open-world-foods.md` (D8 population prior, W1b) and the ruling
`docs/decisions/2026-10-05-nhanes-aggregate-use.md`.

## Goal

The U.S. prior (W1b) is a survey-weighted Day 1 prevalence from NHANES. This spec describes two
optional refinements and a Canadian build. Each is a prior over foods that raises or lowers rank
and never admits, excludes or changes a safety verdict (`tests/meals/ranking-boundary.test.ts`).

## 1. U.S. refinement

- **ACS re-weighting.** Re-weight the NHANES respondents so the sex-by-age-band cells match the
  American Community Survey's adult population. Aggregates only: the offline workspace holds the
  respondent rows; the artifact keeps `{ cohort, food_key, rate, n_eff }` with `n_eff >= 30`.
- **CE Diary lift.** Consumer Expenditure Diary purchase shares give a per-food lift against the
  NHANES rate. The lift is clamped to `[0.67, 1.5]`, so a purchase signal can move a rate by at
  most half again and never erase or invent a food. A food with no CE match keeps lift 1.

## 2. Canada

- Build the prior from CCHS Nutrition (Day 1 recalls, adults), mapped to the Canadian Nutrient
  File (CNF) through a crosswalk like the FNDDS one in W1b.
- Same artifact shape, same `n_eff >= 30` floor, own manifest and hash. Only an account whose
  stored `country_code = 'CA'` reads it; no or another country is neutral.
- A province split is allowed only when the account holds a province variable (below).

## 3. Entry gates

No part ships until all of these pass, each with a receipt in `docs/priors/`:

1. **NCHS review** of the ACS re-weighting for the NHANES-derived rates, under the existing
   aggregate-use ruling.
2. **CCHS licence**: the Statistics Canada licence for the CCHS file in use is read and allows
   aggregate derived rates in a shipped artifact; the licence check in `check-artifact.ts` lists it.
3. **Province variable**: a Canadian province field exists as a user-set setting, before any
   provincial cohort. It is never inferred from a zone, location or model. Without it only the
   national root is used.
4. **The section-5 lift test**: the prior must beat the neutral baseline on the held-out replay and
   holdout calibration defined in phase-18 §5, with the same targets as the pairing `co` term.
   Failing leaves the weight at 0.

## 4. Never

No state, region, race or ethnicity field, in the artifact, the settings or any payload to a
model. Race and Hispanic origin stay in the offline fairness audit only. Guarded by
`tests/foods/nhanes-no-microdata.test.ts`.
