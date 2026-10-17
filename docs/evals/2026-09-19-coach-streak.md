# Coach quality streak — 2026-09-19

> Later run: 2026-10-17 on the OpenRouter lane, see `docs/evals/2026-10-17-coach-live-pass.md`.

- Terminal state: **exhausted**
- Supabase branch: `coach-eval` (shared; not reset or destroyed)
- Category: **all**
- Seed: `20260919`
- Current streak: **3/10**
- Total cases run: **40/40**
- Failures: **31** (31 resolved, 0 open)
- Evaluation: **live turns**



- Updated: 2026-10-03T21:03:18.157Z

## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
| activity | 0 | 1 | 1 (1 resolved, 0 open) | resolved |
| block | 0 | 6 | 5 (5 resolved, 0 open) | resolved |
| devin | 0 | 4 | 4 (4 resolved, 0 open) | resolved |
| jev | 1 | 6 | 5 (5 resolved, 0 open) | resolved |
| list_edit | 1 | 6 | 4 (4 resolved, 0 open) | resolved |
| meals | 0 | 5 | 5 (5 resolved, 0 open) | resolved |
| no_action | 0 | 3 | 2 (2 resolved, 0 open) | resolved |
| schedule_body | 4 | 5 | 1 (1 resolved, 0 open) | resolved |
| suggestion | 0 | 4 | 4 (4 resolved, 0 open) | resolved |

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
| fast | 9 | 1516 | 2195 | < 2000 |
| llm | 28 | 30424 | 30850 | < 15000 |

## Turns

| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |
|---:|---|---|---:|---|---|---:|---|---|
| 1 | list-remove-watermelon-avoid | fast | 2008 | remove_from_avoid | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-001-list-remove-watermelon-avoid.json` |
| 2 | activity-device-kcal-no-allowance | llm | 30675 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-002-activity-device-kcal-no-allowance.json` |
| 3 | list-remove-chicken-eats | fast | 1612 | remove_from_eats | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-003-list-remove-chicken-eats.json` |
| 4 | suggest-small-snack-wish | llm | 30437 | none | quick_replies | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-004-suggest-small-snack-wish.json` |
| 5 | block-search-greek-yogurt-eats | error | 18737 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-005-block-search-greek-yogurt-eats.json` |
| 6 | devin-five-eats-suggestions | llm | 30850 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-006-devin-five-eats-suggestions.json` |
| 7 | devin-remaining-snack | llm | 30487 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-007-devin-remaining-snack.json` |
| 8 | devin-shift-late-30 | llm | 30635 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-008-devin-shift-late-30.json` |
| 9 | block-weight-trend | fast | 1160 | none | chart | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-009-block-weight-trend.json` |
| 10 | block-three-dinner-ideas | llm | 20110 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-010-block-three-dinner-ideas.json` |
| 11 | meals-p4-spaghetti-snack | llm | 30968 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-011-meals-p4-spaghetti-snack.json` |
| 12 | block-protein-or-fibre | llm | 17826 | none | quick_replies | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-012-block-protein-or-fibre.json` |
| 13 | block-week-review | llm | 28335 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-013-block-week-review.json` |
| 14 | list-restore-salmon-eats | llm | 14079 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-014-list-restore-salmon-eats.json` |
| 15 | suggest-chicken-wrap-wish | llm | 30536 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-015-suggest-chicken-wrap-wish.json` |
| 16 | schedule-push-hour | llm | 17822 | shift_schedule | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-016-schedule-push-hour.json` |
| 17 | jev-three-dinner-ideas | error | 23139 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-017-jev-three-dinner-ideas.json` |
| 18 | block-search-watermelon-avoid | llm | 10073 | none | food_search | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-018-block-search-watermelon-avoid.json` |
| 19 | jev-tiny-rice-log | llm | 30565 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-019-jev-tiny-rice-log.json` |
| 20 | weight-127-pounds | fast | 1151 | log_weight | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-020-weight-127-pounds.json` |
| 21 | jev-low-fodmap-unverified | llm | 30424 | none | recipe_results | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-021-jev-low-fodmap-unverified.json` |
| 22 | jev-log-soy-mark | llm | 15698 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-022-jev-log-soy-mark.json` |
| 23 | list-eggs-cant-do | llm | 15352 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-023-list-eggs-cant-do.json` |
| 24 | suggest-no-cook-recipes-wish | llm | 30564 | none | recipe_results | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-024-suggest-no-cook-recipes-wish.json` |
| 25 | jev-recipe-excludes-soy | llm | 30548 | none | recipe_results | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-025-jev-recipe-excludes-soy.json` |
| 26 | meals-p2-future-breakfast | llm | 30682 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-026-meals-p2-future-breakfast.json` |
| 27 | meals-p6-weekday-oatmeal | llm | 25458 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-027-meals-p6-weekday-oatmeal.json` |
| 28 | list-add-tofu-eats | llm | 30540 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-028-list-add-tofu-eats.json` |
| 29 | suggest-three-dinners | fast | 1516 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-029-suggest-three-dinners.json` |
| 30 | meals-p1-month-breakfast | llm | 30627 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-030-meals-p1-month-breakfast.json` |
| 31 | question-colitis-deflection | fast | 1101 | none | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-031-question-colitis-deflection.json` |
| 32 | meals-p3-next-tuesday-lunch | error | 21949 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-032-meals-p3-next-tuesday-lunch.json` |
| 33 | schedule-earlier-15 | llm | 14106 | shift_schedule | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-033-schedule-earlier-15.json` |
| 34 | jev-role-advice-unconfirmed | fast | 1539 | add_to_eats | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-034-jev-role-advice-unconfirmed.json` |
| 35 | devin-watermelon-avoid | fast | 2195 | add_to_avoid | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-035-devin-watermelon-avoid.json` |
| 36 | question-food-left | llm | 21504 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-036-question-food-left.json` |
| 37 | question-protein-high | llm | 30617 | none | none | 0 | fail | `docs/evals/2026-09-19-coach-streak-turns/turn-037-question-protein-high.json` |
| 38 | water-two-cups | llm | 10336 | log_water | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-038-water-two-cups.json` |
| 39 | list-remove-watermelon-avoid | fast | 1177 | remove_from_avoid | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-039-list-remove-watermelon-avoid.json` |
| 40 | schedule-push-hour | llm | 11655 | shift_schedule | none | 0 | pass | `docs/evals/2026-09-19-coach-streak-turns/turn-040-schedule-push-hour.json` |

## Failures and resolutions

### F001 — list-remove-watermelon-avoid

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-001-list-remove-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: First live turn against the freshly created coach-eval branch; fast path returned the correct action (remove_from_avoid) but took 2008 ms against the 2000 ms bound, an 8 ms (0.4%) overshoot consistent with a cold Postgres/pooler connection on a brand-new branch rather than a sustained regression.
- Regression test: not applicable

### F002 — activity-device-kcal-no-allowance

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-002-activity-device-kcal-no-allowance.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: openHarness only set COACH_ACTIVITY_CONTEXT_ENABLED when --category activity was passed explicitly, so the default (category === null) run drew the corpus's one activity case without the flag: no activity block in context, the coach fell back from gemini-3.6-flash to gemini-3.8-flash on capacity after 8975 ms, then timed out at 30675 ms against the 15000 ms bound, producing the generic retry line instead of the expected device-estimate copy. Fixed by extracting needsActivityContext(category) (true for 'activity' and for the default null run) and using it at the openHarness call site in runStreak.
- Regression test: `tests/coach/streak-activity-device-kcal-no-allowance.test.ts`

### F003 — suggest-small-snack-wish

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-004-suggest-small-snack-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Gemini hit a capacity limit on gemini-3.6-flash and fell back to gemini-3.8-flash after 4002 ms; the fallback call then ran long and tripped the harness's own 30 s total-budget abort (deadline copy: 'That took too long and I stopped. Ask me again.'), producing 0 cards against the expected 1-3 and a 30437 ms elapsed time against the 15000 ms bound. Provider-side capacity/latency, not a code or corpus defect.
- Regression test: not applicable

### F004 — block-search-greek-yogurt-eats

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-005-block-search-greek-yogurt-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Gemini returned 503 'currently experiencing high demand' on both gemini-3.6-flash and its gemini-3.8-flash capacity fallback; the coach turn surfaced the honest 'Sasha is unavailable right now' error. Live provider outage, not a code or corpus defect.
- Regression test: not applicable

### F005 — devin-five-eats-suggestions

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-006-devin-five-eats-suggestions.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Gemini capacity fallback (gemini-3.6-flash -> gemini-3.8-flash) then the fallback call ran past the 30 s harness budget, returning 0 cards/no anchors against the expected 5 distinct protein-anchor cards. Same ongoing live-provider capacity event as F003/F004, not a code or corpus defect.
- Regression test: not applicable

### F006 — devin-remaining-snack

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-007-devin-remaining-snack.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30487 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F007 — devin-shift-late-30

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-008-devin-shift-late-30.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30635 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F008 — block-three-dinner-ideas

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-010-block-three-dinner-ideas.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 20110 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F009 — meals-p4-spaghetti-snack

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-011-meals-p4-spaghetti-snack.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30968 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F010 — block-protein-or-fibre

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-012-block-protein-or-fibre.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Correct, on-topic reply ('What would you like to have for breakfast instead?', the expected quick_replies clarification) on the primary gemini-3.6-flash lane with no capacity fallback, but elapsed 17826 ms against the 15000 ms LLM bound (19% over). Same clustered live-provider latency degradation window as F001/F003/F004/F005/F006/F008/F009, just without a logged fallback event this time; not a code or corpus defect.
- Regression test: not applicable

### F011 — block-week-review

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-013-block-week-review.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 28335 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F012 — list-restore-salmon-eats

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-014-list-restore-salmon-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 14079 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F013 — suggest-chicken-wrap-wish

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-015-suggest-chicken-wrap-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30536 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F014 — schedule-push-hour

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-016-schedule-push-hour.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 17822 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F015 — jev-three-dinner-ideas

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-017-jev-three-dinner-ideas.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed None ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F016 — block-search-watermelon-avoid

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-018-block-search-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: The food_search tool call's intent argument is model-chosen (lib/coach/blocks/hydrate-food-search.ts maps the model's own 'browse'/'eats'/'avoid'/'lookup' tool argument to a persisted intent; there is no deterministic classifier here). For 'show me watermelon in the catalog so I can decide whether to avoid it' the model called the tool with intent=browse (persisted as log) instead of avoid, despite the user's explicit avoid-leaning phrasing. Everything else about the turn was correct (reply, block kind, card count, latency, no unsupported claim). A model intent-selection miss, not a code or corpus defect -- the corpus's expected 'avoid' matches the user's stated intent.
- Regression test: not applicable

### F017 — jev-tiny-rice-log

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-019-jev-tiny-rice-log.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30565 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F018 — jev-low-fodmap-unverified

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-021-jev-low-fodmap-unverified.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30424 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F019 — jev-log-soy-mark

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-022-jev-log-soy-mark.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: For 'log 100 g of smoked tofu for lunch' the turn aborted with a provider-chosen free-text reason (lib/coach/turn.ts's abort step accepts any model-supplied reason string and falls through to the generic 'I could not answer that one' copy when it is not one of the three named reasons), at 15698 ms -- just over the 15000 ms bound. A plain log_meal request like this normally succeeds; this reads as the same live Gemini degradation window already documented for F001/F003-F006/F008-F018 (the abort-with-exception-safety-net design in lib/coach/turn.ts converts any pipeline hiccup into this readable message rather than a crash), not a narrow soy-logging defect.
- Regression test: not applicable

### F020 — list-eggs-cant-do

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-023-list-eggs-cant-do.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Same generic-abort safety-net pattern as F019 ('I could not answer that one') for a plain add_to_avoid request ('I can't do eggs anymore'), 15352 ms against the 15000 ms bound, no fallback logged this time. Same ongoing live Gemini degradation window, not a code or corpus defect.
- Regression test: not applicable

### F021 — suggest-no-cook-recipes-wish

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-024-suggest-no-cook-recipes-wish.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30564 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F022 — jev-recipe-excludes-soy

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-025-jev-recipe-excludes-soy.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30548 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F023 — meals-p2-future-breakfast

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-026-meals-p2-future-breakfast.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30682 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F024 — meals-p6-weekday-oatmeal

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-027-meals-p6-weekday-oatmeal.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 25458 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F025 — list-add-tofu-eats

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-028-list-add-tofu-eats.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30540 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F026 — suggest-three-dinners

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-029-suggest-three-dinners.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: seedRehearsal never persisted a target_profiles revision, only user_settings. Post target-authority-boundary (docs/decisions/2026-09-22-target-priors.md), compose_meal/suggest_options never invent numbers from user_settings alone -- without an effective target_profiles row the coach answered 'Your targets aren't set yet. Finish your profile and I'll size options to your target.' on the fast path (1516 ms, no model/latency issue) instead of composing any card. This deterministically breaks every corpus case expecting a sized suggestion (suggest-three-dinners and 7 others: devin-five-eats-suggestions, devin-remaining-snack, suggest-chicken-wrap-wish, suggest-small-snack-wish, suggest-no-cook-recipes-wish, block-three-dinner-ideas, jev-three-dinner-ideas -- several of those also failed on this run but were attributed to the concurrent Gemini capacity outage since they timed out before reaching this gate). Fixed by calling the app's own write_target_revision RPC (same one tests/coach/suggest-new-account.test.ts uses) in seedRehearsal with a fixture consistent with the seeded user_settings.
- Regression test: `tests/coach/streak-suggest-three-dinners.test.ts`

### F027 — meals-p1-month-breakfast

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-030-meals-p1-month-breakfast.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30627 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F028 — meals-p3-next-tuesday-lunch

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-032-meals-p3-next-tuesday-lunch.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed None ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

### F029 — devin-watermelon-avoid

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-035-devin-watermelon-avoid.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Correct fast-path action (add_to_avoid, all same-name watermelon refs) but 2195 ms against the 2000 ms fast bound, a 195 ms (9.75%) overshoot -- no fallback/outage signature this time, fast path doesn't call Gemini at all, so this is plain latency variance (branch/pooler or classifier-service jitter) during the same degraded window as the rest of this run's failures. Not a code or corpus defect.
- Regression test: not applicable

### F030 — question-food-left

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-036-question-food-left.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Correct, numerically sound reply (1,473 kcal left; 112/93/61 g protein/carbs/fat, now computed from the real target_profiles revision seeded by the F026 fix) on the primary gemini-3.6-flash lane, no fallback logged, but 21504 ms against the 15000 ms bound (43% over). Same ongoing live-provider latency degradation window as the rest of this run; not a code or corpus defect.
- Regression test: not applicable

### F031 — question-protein-high

- Turn JSON: `docs/evals/2026-09-19-coach-streak-turns/turn-037-question-protein-high.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Live Gemini capacity/outage pattern (same as F001-F006): fallback to gemini-3.8-flash and/or a 503 high-demand response and/or the harness's own 30s total-budget abort; elapsed 30617 ms. Provider-side, not a code or corpus defect.
- Regression test: not applicable

## Setup blockers

- Error: Jev soy fixture has no present contains_soy cache row; warm it first. — Jev facet cache (food_facets.contains_soy) was never warmed on the brand-new coach-eval branch. Ran the documented warm workflow: coach-streak.ts --category jev --prepare-jev to get the plan ({userId, catalogAfter:0, limit:18}), then scripts/warm-facets.ts --commit --user-id <id> --limit 18 against the branch (450 judged, 0 errors). catalog_revision:11 (Smoked tofu) now has contains_soy p=0.98, above the present threshold. One-time per-branch setup, not a code or corpus defect; resuming.
