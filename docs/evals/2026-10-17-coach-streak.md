# Coach quality streak — 2026-10-17

- Terminal state: **exhausted**
- Supabase branch: `coach-eval` (shared; not reset or destroyed)
- Category: **all**
- Seed: `20260919`
- Current streak: **1/10**
- Total cases run: **40/40**
- Failures: **27** (27 resolved, 0 open)
- Evaluation: **live turns**



- Updated: 2026-10-17T08:40:10.492Z

## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
| activity | 1 | 1 | 0 (0 resolved, 0 open) | clear |
| block | 0 | 6 | 5 (5 resolved, 0 open) | resolved |
| devin | 2 | 4 | 2 (2 resolved, 0 open) | resolved |
| jev | 0 | 6 | 6 (6 resolved, 0 open) | resolved |
| list_edit | 0 | 6 | 5 (5 resolved, 0 open) | resolved |
| meals | 0 | 5 | 5 (5 resolved, 0 open) | resolved |
| no_action | 3 | 3 | 0 (0 resolved, 0 open) | clear |
| schedule_body | 5 | 5 | 0 (0 resolved, 0 open) | clear |
| suggestion | 0 | 4 | 4 (4 resolved, 0 open) | resolved |

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
| fast | 4 | 1049 | 1639 | < 2000 |
| llm | 36 | 4675 | 10463 | < 15000 |

## Turns

| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |
|---:|---|---|---:|---|---|---:|---|---|
| 1 | list-remove-watermelon-avoid | llm | 4530 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-001-list-remove-watermelon-avoid.json` |
| 2 | activity-device-kcal-no-allowance | llm | 3387 | none | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-002-activity-device-kcal-no-allowance.json` |
| 3 | list-remove-chicken-eats | fast | 1157 | remove_from_eats | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-003-list-remove-chicken-eats.json` |
| 4 | suggest-small-snack-wish | llm | 7511 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-004-suggest-small-snack-wish.json` |
| 5 | block-search-greek-yogurt-eats | llm | 4008 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-005-block-search-greek-yogurt-eats.json` |
| 6 | devin-five-eats-suggestions | llm | 10463 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-006-devin-five-eats-suggestions.json` |
| 7 | devin-remaining-snack | llm | 10194 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-007-devin-remaining-snack.json` |
| 8 | devin-shift-late-30 | llm | 5029 | shift_schedule | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-008-devin-shift-late-30.json` |
| 9 | block-weight-trend | llm | 5103 | none | chart | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-009-block-weight-trend.json` |
| 10 | block-three-dinner-ideas | llm | 7349 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-010-block-three-dinner-ideas.json` |
| 11 | meals-p4-spaghetti-snack | llm | 6389 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-011-meals-p4-spaghetti-snack.json` |
| 12 | block-protein-or-fibre | llm | 6800 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-012-block-protein-or-fibre.json` |
| 13 | block-week-review | llm | 13295 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-013-block-week-review.json` |
| 14 | list-restore-salmon-eats | llm | 3743 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-014-list-restore-salmon-eats.json` |
| 15 | suggest-chicken-wrap-wish | llm | 7702 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-015-suggest-chicken-wrap-wish.json` |
| 16 | schedule-push-hour | llm | 4161 | shift_schedule | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-016-schedule-push-hour.json` |
| 17 | jev-three-dinner-ideas | llm | 7349 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-017-jev-three-dinner-ideas.json` |
| 18 | block-search-watermelon-avoid | llm | 5943 | none | food_search, next_action_chip | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-018-block-search-watermelon-avoid.json` |
| 19 | jev-tiny-rice-log | llm | 4387 | log_meal, delete_entry | next_action_chip | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-019-jev-tiny-rice-log.json` |
| 20 | weight-127-pounds | fast | 1049 | log_weight | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-020-weight-127-pounds.json` |
| 21 | jev-low-fodmap-unverified | llm | 9035 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-021-jev-low-fodmap-unverified.json` |
| 22 | jev-log-soy-mark | llm | 4331 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-022-jev-log-soy-mark.json` |
| 23 | list-eggs-cant-do | llm | 4250 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-023-list-eggs-cant-do.json` |
| 24 | suggest-no-cook-recipes-wish | llm | 5830 | none | recipe_results | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-024-suggest-no-cook-recipes-wish.json` |
| 25 | jev-recipe-excludes-soy | llm | 5882 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-025-jev-recipe-excludes-soy.json` |
| 26 | meals-p2-future-breakfast | llm | 6326 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-026-meals-p2-future-breakfast.json` |
| 27 | meals-p6-weekday-oatmeal | llm | 5490 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-027-meals-p6-weekday-oatmeal.json` |
| 28 | list-add-tofu-eats | llm | 3938 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-028-list-add-tofu-eats.json` |
| 29 | suggest-three-dinners | llm | 6919 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-029-suggest-three-dinners.json` |
| 30 | meals-p1-month-breakfast | llm | 3244 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-030-meals-p1-month-breakfast.json` |
| 31 | question-colitis-deflection | fast | 540 | none | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-031-question-colitis-deflection.json` |
| 32 | meals-p3-next-tuesday-lunch | llm | 4148 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-032-meals-p3-next-tuesday-lunch.json` |
| 33 | schedule-earlier-15 | llm | 3708 | shift_schedule | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-033-schedule-earlier-15.json` |
| 34 | jev-role-advice-unconfirmed | llm | 3370 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-034-jev-role-advice-unconfirmed.json` |
| 35 | devin-watermelon-avoid | fast | 1639 | add_to_avoid | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-035-devin-watermelon-avoid.json` |
| 36 | question-food-left | llm | 3319 | none | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-036-question-food-left.json` |
| 37 | question-protein-high | llm | 4065 | none | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-037-question-protein-high.json` |
| 38 | water-two-cups | llm | 4675 | log_water | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-038-water-two-cups.json` |
| 39 | list-remove-watermelon-avoid | llm | 4252 | none | none | 0 | fail | `docs/evals/2026-10-17-coach-streak-turns/turn-039-list-remove-watermelon-avoid.json` |
| 40 | schedule-push-hour | llm | 4084 | shift_schedule | none | 0 | pass | `docs/evals/2026-10-17-coach-streak-turns/turn-040-schedule-push-hour.json` |

## Failures and resolutions

### F001 — list-remove-watermelon-avoid

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-001-list-remove-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F002 — suggest-small-snack-wish

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-004-suggest-small-snack-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F003 — block-search-greek-yogurt-eats

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-005-block-search-greek-yogurt-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F004 — devin-five-eats-suggestions

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-006-devin-five-eats-suggestions.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F005 — devin-remaining-snack

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-007-devin-remaining-snack.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F006 — block-three-dinner-ideas

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-010-block-three-dinner-ideas.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F007 — meals-p4-spaghetti-snack

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-011-meals-p4-spaghetti-snack.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F008 — block-protein-or-fibre

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-012-block-protein-or-fibre.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F009 — block-week-review

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-013-block-week-review.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F010 — list-restore-salmon-eats

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-014-list-restore-salmon-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F011 — suggest-chicken-wrap-wish

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-015-suggest-chicken-wrap-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F012 — jev-three-dinner-ideas

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-017-jev-three-dinner-ideas.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F013 — block-search-watermelon-avoid

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-018-block-search-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F014 — jev-tiny-rice-log

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-019-jev-tiny-rice-log.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F015 — jev-low-fodmap-unverified

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-021-jev-low-fodmap-unverified.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F016 — jev-log-soy-mark

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-022-jev-log-soy-mark.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F017 — list-eggs-cant-do

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-023-list-eggs-cant-do.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F018 — suggest-no-cook-recipes-wish

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-024-suggest-no-cook-recipes-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F019 — jev-recipe-excludes-soy

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-025-jev-recipe-excludes-soy.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F020 — meals-p2-future-breakfast

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-026-meals-p2-future-breakfast.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F021 — meals-p6-weekday-oatmeal

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-027-meals-p6-weekday-oatmeal.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F022 — list-add-tofu-eats

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-028-list-add-tofu-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F023 — suggest-three-dinners

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-029-suggest-three-dinners.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F024 — meals-p1-month-breakfast

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-030-meals-p1-month-breakfast.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F025 — meals-p3-next-tuesday-lunch

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-032-meals-p3-next-tuesday-lunch.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F026 — jev-role-advice-unconfirmed

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-034-jev-role-advice-unconfirmed.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

### F027 — list-remove-watermelon-avoid

- Turn JSON: `docs/evals/2026-10-17-coach-streak-turns/turn-039-list-remove-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: W087 auto-filed; cause guess recorded in docs/evals/2026-10-17-coach-live-pass.md
- Regression test: not applicable

## Setup blockers

No setup blockers.
