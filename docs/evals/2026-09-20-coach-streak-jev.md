# Coach Jev quality streak — 2026-09-20

- Terminal state: **success**
- Supabase branch: `chat-first-2026-09-19` (shared; not reset or destroyed)
- Category: **jev**
- Seed: `20260919`
- Current streak: **6/6**
- Total cases run: **18/30**
- Failures: **4** (4 resolved, 0 open)
- Evaluation: **live turns**
- Facet warming: **20 foods, 4 calls, $0.00207572**

- Facet warming target: **`target: branch klxabxejwktevxewtvqi.supabase.co`**

- Updated: 2026-09-20T09:11:47.134Z

## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
| jev | 6 | 18 | 4 (4 resolved, 0 open) | success |

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
| fast | 2 | 1298 | 1859 | < 2000 |
| llm | 16 | 7659 | 10577 | < 15000 |

## Turns

| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |
|---:|---|---|---:|---|---|---:|---|---|
| 1 | jev-three-dinner-ideas | llm | 10577 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-001-jev-three-dinner-ideas.json` |
| 2 | jev-tiny-rice-log | llm | 4694 | log_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-002-jev-tiny-rice-log.json` |
| 3 | jev-log-soy-mark | llm | 7659 | log_meal | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-003-jev-log-soy-mark.json` |
| 4 | jev-role-advice-unconfirmed | llm | 7132 | none | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-004-jev-role-advice-unconfirmed.json` |
| 5 | jev-low-fodmap-unverified | llm | 9446 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-005-jev-low-fodmap-unverified.json` |
| 6 | jev-recipe-excludes-soy | llm | 10043 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-006-jev-recipe-excludes-soy.json` |
| 7 | jev-three-dinner-ideas | llm | 9795 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-007-jev-three-dinner-ideas.json` |
| 8 | jev-recipe-excludes-soy | llm | 5323 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-008-jev-recipe-excludes-soy.json` |
| 9 | jev-log-soy-mark | llm | 7141 | log_meal | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-009-jev-log-soy-mark.json` |
| 10 | jev-tiny-rice-log | llm | 5020 | log_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-010-jev-tiny-rice-log.json` |
| 11 | jev-low-fodmap-unverified | llm | 9270 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-011-jev-low-fodmap-unverified.json` |
| 12 | jev-role-advice-unconfirmed | fast | 1298 | add_to_eats | none | 0 | fail | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-012-jev-role-advice-unconfirmed.json` |
| 13 | jev-role-advice-unconfirmed | fast | 1859 | add_to_eats | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-013-jev-role-advice-unconfirmed.json` |
| 14 | jev-log-soy-mark | llm | 4940 | log_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-014-jev-log-soy-mark.json` |
| 15 | jev-low-fodmap-unverified | llm | 9571 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-015-jev-low-fodmap-unverified.json` |
| 16 | jev-tiny-rice-log | llm | 4560 | log_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-016-jev-tiny-rice-log.json` |
| 17 | jev-three-dinner-ideas | llm | 9509 | none | food_ideas | 3 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-017-jev-three-dinner-ideas.json` |
| 18 | jev-recipe-excludes-soy | llm | 10001 | save_recipe | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-jev-turns/turn-018-jev-recipe-excludes-soy.json` |

## Failures and resolutions

### F001 — jev-log-soy-mark

- Turn JSON: `docs/evals/2026-09-20-coach-streak-jev-turns/turn-003-jev-log-soy-mark.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: Cached facet evidence was never loaded for final log actions. Added a cache-only log policy pass that marks rather than refuses, persists the blocked verdict and flagged name, and appends an off-plan notice; unavailable evidence remains unverified.
- Regression test: `tests/coach/streak-jev-soy-log.test.ts`

### F002 — jev-role-advice-unconfirmed

- Turn JSON: `docs/evals/2026-09-20-coach-streak-jev-turns/turn-004-jev-role-advice-unconfirmed.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: Coach grounding searched only catalog rows, so the exact role-less custom food was dropped before C4 role advice. Added an exact account-scoped user-food fallback and a read-only Jev role-advice pass for grounded Eats/Avoid additions; the synthetic food now has unambiguous protein-anchor macros.
- Regression test: `tests/coach/streak-jev-role-advice.test.ts`

### F003 — jev-log-soy-mark

- Turn JSON: `docs/evals/2026-09-20-coach-streak-jev-turns/turn-009-jev-log-soy-mark.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: The commit path recomputed policy from allergen and Avoid evidence only, so it erased the cached soy mark even after action grounding was fixed. It now merges cache-only preference facets at commit with facetAction mark and keeps the existing write-through behavior.
- Regression test: `tests/coach/streak-jev-soy-log.test.ts`

### F004 — jev-role-advice-unconfirmed

- Turn JSON: `docs/evals/2026-09-20-coach-streak-jev-turns/turn-012-jev-role-advice-unconfirmed.json`
- Status: resolved
- Diagnosis: code defect
- Resolution: The fast action path returned immediately after basic grounding and bypassed the post-grounding role-advice pipeline. Both fast and LLM action paths now share the same log-mark, role-advice, and recipe-policy application before persistence.
- Regression test: `tests/coach/run-turn-role-advice.test.ts`

## Setup blockers

No setup blockers.
