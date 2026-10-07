# NHANES aggregate use for food-preference priors

Date: 2026-10-05. Decided by: Devin (owner).

## Decision

Meal Companion may use NHANES / What We Eat in America public-use data to compute
survey-weighted, cohort-level food and ingredient prevalence, and ship those aggregate tables as
population priors for recommendations (Phase 18, `docs/specs/phase-18-open-world-foods.md`).

## Basis

The NCHS Data User Agreement (https://www.cdc.gov/nchs/policy/data-user-agreement.html, page
dated 2024-09-17, read 2026-10-05) limits use to statistical reporting and analysis, forbids
identifying anyone, linking the data with individually identifiable data, and re-identification
research. It does not mention commercial use. Cohort aggregates applied to an app user are
statistics, not record linkage. Research brief:
`~/Inbox/notes/2026-10-05-food-preference-priors-research.md`.

## Hard rules for the build pipeline

1. Never ship or store respondent-level rows in the product.
2. Never join NHANES microdata to any user record.
3. Suppress cohort cells below the minimum-n floor.
4. Pipeline outputs are aggregate tables only.

Each rule gets a named check in the Phase 18 data build (slice W1b).

## Not decided here

Emailing NCHS for written confirmation stays optional. This is the owner's reading, not legal
advice.
