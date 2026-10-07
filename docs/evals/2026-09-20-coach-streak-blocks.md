# Coach block quality streak — 2026-09-20

- Terminal state: **success**
- Supabase branch: `chat-first-2026-09-19` (shared; not reset or destroyed)
- Category: **block**
- Seed: `20260919`
- Current streak: **6/6**
- Total cases run: **24/30**
- Failures: **6** (6 resolved, 0 open)
- Evaluation: **re-derived offline from 24 stored turn JSONs; no network or provider calls**
- Updated: 2026-09-20T06:18:02.489Z

## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
| block | 6 | 24 | 6 (6 resolved, 0 open) | success |

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
| fast | 4 | 1022 | 1279 | < 2000 |
| llm | 20 | 7556 | 9559 | < 15000 |

## Turns

| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |
|---:|---|---|---:|---|---|---:|---|---|
| 1 | block-search-watermelon-avoid | llm | 7527 | add_to_avoid | food_search | 0 | fail | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-001-block-search-watermelon-avoid.json` |
| 2 | block-search-greek-yogurt-eats | llm | 7447 | add_to_eats | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-002-block-search-greek-yogurt-eats.json` |
| 3 | block-weight-trend | fast | 1279 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-003-block-weight-trend.json` |
| 4 | block-three-dinner-ideas | llm | 9559 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-004-block-three-dinner-ideas.json` |
| 5 | block-protein-or-fibre | llm | 3902 | none | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-005-block-protein-or-fibre.json` |
| 6 | block-week-review | llm | 8259 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-006-block-week-review.json` |
| 7 | block-search-watermelon-avoid | llm | 6703 | none | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-007-block-search-watermelon-avoid.json` |
| 8 | block-week-review | llm | 6689 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-008-block-week-review.json` |
| 9 | block-weight-trend | fast | 998 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-009-block-weight-trend.json` |
| 10 | block-search-greek-yogurt-eats | llm | 7556 | add_to_eats | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-010-block-search-greek-yogurt-eats.json` |
| 11 | block-protein-or-fibre | llm | 8855 | none | food_ideas | 3 | fail | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-011-block-protein-or-fibre.json` |
| 12 | block-three-dinner-ideas | llm | 8945 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-012-block-three-dinner-ideas.json` |
| 13 | block-three-dinner-ideas | llm | 9335 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-013-block-three-dinner-ideas.json` |
| 14 | block-weight-trend | fast | 1022 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-014-block-weight-trend.json` |
| 15 | block-protein-or-fibre | llm | 5904 | none | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-015-block-protein-or-fibre.json` |
| 16 | block-search-greek-yogurt-eats | llm | 7944 | add_to_eats | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-016-block-search-greek-yogurt-eats.json` |
| 17 | block-search-watermelon-avoid | llm | 6172 | none | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-017-block-search-watermelon-avoid.json` |
| 18 | block-week-review | llm | 6094 | none | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-018-block-week-review.json` |
| 19 | block-search-greek-yogurt-eats | llm | 7768 | add_to_eats | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-019-block-search-greek-yogurt-eats.json` |
| 20 | block-weight-trend | fast | 1106 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-020-block-weight-trend.json` |
| 21 | block-search-watermelon-avoid | llm | 8558 | none | food_search | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-021-block-search-watermelon-avoid.json` |
| 22 | block-week-review | llm | 6334 | none | chart | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-022-block-week-review.json` |
| 23 | block-protein-or-fibre | llm | 10232 | none | quick_replies | 0 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-023-block-protein-or-fibre.json` |
| 24 | block-three-dinner-ideas | llm | 8761 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-024-block-three-dinner-ideas.json` |

## Failures and resolutions

### F001 — block-search-watermelon-avoid

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-001-block-search-watermelon-avoid.json`
- Status: resolved
- Diagnosis: corpus expectation wrong
- Resolution: The sentence stated the avoid intent, so Gemini acting (add_to_avoid) alongside the food_search block was acceptable model behaviour; the case now asks for a lookup before deciding: 'show me watermelon in the catalog so I can decide whether to avoid it'.
- Regression test: not applicable

### F002 — block-search-greek-yogurt-eats

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-002-block-search-greek-yogurt-eats.json`
- Status: resolved
- Diagnosis: corpus expectation wrong
- Resolution: The sentence explicitly asks to put greek yogurt on Eats; Gemini did so (add_to_eats) with the food_search block and named the dairy off-plan mark. The case now expects add_to_eats plus the block.
- Regression test: not applicable

### F003 — block-protein-or-fibre

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-005-block-protein-or-fibre.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: Gemini answered 'should I eat more protein or more fibre?' directly and correctly (protein first, 102 g remaining) instead of offering quick replies — acceptable. Mitigation: the case now asks explicitly for two or three quick options to pick from, which is what the quick_replies block is for; the prompt is unchanged.
- Regression test: not applicable

### F004 — block-protein-or-fibre

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-011-block-protein-or-fibre.json`
- Status: resolved
- Diagnosis: corpus expectation wrong
- Resolution: The reworded sentence asked for 'two or three quick options', which in a food coach means meal options; Gemini answered correctly with three composed meals and a food_ideas block. quick_replies is for a clarifying question with choices, so the case now asks 'can you change my breakfast?' (move it, swap the foods, or skip it) and keeps the quick_replies expectation; id kept for history.
- Regression test: not applicable

### F005 — block-protein-or-fibre

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-015-block-protein-or-fibre.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: Third failure of the quick_replies kind with the block's own trigger present (the coach asked a clarifying question with no choices). Prompt guidance now binds quick_replies to the coach's own question in the same step with 2–4 choices; regression test pins the wording; wire.ts untouched.
- Regression test: `tests/coach/streak-block-quick-replies.test.ts`

### F006 — block-week-review

- Turn JSON: `docs/evals/2026-09-20-coach-streak-blocks-turns/turn-018-block-week-review.json`
- Status: resolved
- Diagnosis: model behaviour
- Resolution: First failure of this kind: for 'how did this week go?' Gemini called get_week_totals but not show_chart (the two earlier passes called both) and its reply still said 'Here is your calorie breakdown for the week'. Prompt unchanged on one occurrence. Mitigation noted for follow-up: extend the no-unsupported-claim verifier to block claims (a reply that says 'here is your chart/breakdown' must carry a block).
- Regression test: not applicable

## Setup blockers

- Error: test_reset_user: Could not find the function public.test_reset_user(p_user_id) in the schema cache — driver applied supabase/seed/test_helpers.sql to the branch and reloaded the PostgREST schema cache
