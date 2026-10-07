# Coach meals quality streak — 2026-09-20

- Terminal state: **success**
- Supabase branch: `meals-2-2026-09-20` (shared; not reset or destroyed)
- Category: **meals**
- Seed: `20260919`
- Current streak: **5/5**
- Total cases run: **5/25**
- Failures: **0** (0 resolved, 0 open)
- Evaluation: **live turns**


- Provider spend: **$0.05877156** (google: 9 calls, $0.05833350, gemini-3.6-flash; typesafe: 12 calls, $0.00043806, jev-1.13.0)

- Updated: 2026-09-20T15:18:08.198Z

## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
| meals | 5 | 5 | 0 (0 resolved, 0 open) | success |

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
| fast | 0 | — | — | < 2000 |
| llm | 5 | 5398 | 5616 | < 15000 |

## Turns

| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |
|---:|---|---|---:|---|---|---:|---|---|
| 1 | meals-p1-month-breakfast | llm | 5616 | set_slot_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-meals-turns/turn-001-meals-p1-month-breakfast.json` |
| 2 | meals-p2-future-breakfast | llm | 5586 | none | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-meals-turns/turn-002-meals-p2-future-breakfast.json` |
| 3 | meals-p3-next-tuesday-lunch | llm | 5398 | set_slot_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-meals-turns/turn-003-meals-p3-next-tuesday-lunch.json` |
| 4 | meals-p4-spaghetti-snack | llm | 4334 | log_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-meals-turns/turn-004-meals-p4-spaghetti-snack.json` |
| 5 | meals-p6-weekday-oatmeal | llm | 3364 | set_slot_meal | none | 0 | pass | `docs/evals/2026-09-20-coach-streak-meals-turns/turn-005-meals-p6-weekday-oatmeal.json` |

## Failures and resolutions

No failures. No regression tests were needed.

## Setup blockers

No setup blockers.
