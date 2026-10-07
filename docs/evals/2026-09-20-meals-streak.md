# Meals coach live streak — 2026-09-20

## Result

**PASS — 5/5 consecutive live cases.** The run used the real Jev and Gemini providers with the
runner's dedicated test user on local Docker Supabase only. Before both the focused rerun and the
full streak, `SUPABASE_URL` and `SUPABASE_TEST_URL` were required to begin with
`http://127.0.0.1`; the commands aborted otherwise.

| Case | Result | Latency | Contract evidence |
|---|---:|---:|---|
| P1 — month of breakfasts | Pass | 5,616 ms | One `set_slot_meal`; `meal-1`; 31 dates from 2026-09-20 through 2026-10-20; title `Sourdough toast, bacon & eggs`; 604 kcal; all 31 titled overrides acknowledged through the phone sync RPC. |
| P2 — breakfast on +15 days | Pass | 5,586 ms | Same thread as P1; no action; the materialized 2026-10-05 row held the same title; reply said `Sourdough toast, bacon & eggs`. |
| P3 — next Tuesday's lunch | Pass | 5,398 ms | One `set_slot_meal`; 2026-09-22 only; `meal-2`; title `Grilled chicken & rice`; 348 kcal. |
| P4 — spaghetti snack | Pass | 4,334 ms | One `log_meal`; `snack`; title `Spaghetti bolognese`, never `Snack`; 480 kcal. |
| P6 — weekday oatmeal | Pass | 3,364 ms | One `set_slot_meal`; `meal-1`; ten Monday–Friday dates in the inclusive 2026-09-20 through 2026-10-03 window; title `Oatmeal with blueberries`; 251 kcal. |

Every case also passed its expected action-kind/card checks, the 15-second LLM bound, the
unsupported-claim verifier, and a before/after assertion proving `runTurn` did not write
`plan_days` or `log_entries`. Series materialization happened only after `runTurn` returned, through
the authenticated sync RPC that represents the phone-side apply boundary.

## Performance and spend

- Actual-path latency: LLM `n=5`, p50 **5,398 ms**, p95 **5,616 ms**; fast path `n=0`.
- Gemini: **9 calls**, **$0.05833350**, model `gemini-3.6-flash`.
- Jev/TypeSafe: **12 calls**, **$0.00043806**, model `jev-1.13.0`.
- Total estimated provider spend: **$0.05877156**.

Spend comes from the dedicated local test user's `ai_calls` rows after the completed streak.

## Fix round

The first category attempt passed P1 and failed P2 because the future plan contained the persisted
title but `get_plan` exposed only the slot label and item lines. The smallest fix:

1. adds the resolved dish `title` to each public day-context slot;
2. tells the coach to lead with that exact stored title when `get_plan` returns one; and
3. adds `tests/coach/streak-meals-p2.test.ts` for both the context and prompt seams.

A focused live P2 rerun then passed in 5,472 ms with: “your breakfast is Sourdough toast, bacon &
eggs …”. The full five-case category was rerun fresh afterward and passed 5/5. Failed-round evidence
is preserved under `/Users/zero-suminc./.claude/goal-state/sasha-health-polish/lanes/M3/round-1/`.

The local database logged `coach intent telemetry insert failed: 23514` on the first turn because
its telemetry check constraint does not yet accept the new routing-only `plan_meal` intent. Jev still
ran and its `ai_calls` spend was recorded; this warning did not affect the returned action, phone-side
materialization, or any streak assertion. Production was not read or written.

## Evidence

- Runner report: `docs/evals/2026-09-20-coach-streak-meals.md`
- State and spend: `docs/evals/2026-09-20-coach-streak-meals-state.json`
- Turn JSONs: `docs/evals/2026-09-20-coach-streak-meals-turns/`

Live command:

```bash
pnpm exec tsx scripts/eval/coach-streak.ts --category meals --report
```

Tail:

```text
PASS 1/25 meals-p1-month-breakfast llm 5616 ms streak=1/5
PASS 2/25 meals-p2-future-breakfast llm 5586 ms streak=2/5
PASS 3/25 meals-p3-next-tuesday-lunch llm 5398 ms streak=3/5
PASS 4/25 meals-p4-spaghetti-snack llm 4334 ms streak=4/5
PASS 5/25 meals-p6-weekday-oatmeal llm 3364 ms streak=5/5
Terminal state: success
Current streak: 5/5
Failures: 0
```

Scrubbed gate:

```bash
env -i PATH="$PATH" HOME="$HOME" TERM=dumb bash -c 'cd /Users/zero-suminc./projects/clients/Sasha/meal-companion-meals && pnpm exec tsc --noEmit && pnpm exec vitest run tests/coach/streak-runner.test.ts tests/coach/streak-jev.test.ts tests/coach/prompt.test.ts tests/coach/intent.test.ts tests/speed/file-size.test.ts'
```

Tail:

```text
✓ tests/speed/file-size.test.ts (150 tests) 12ms
✓ tests/coach/intent.test.ts (37 tests) 9ms
✓ tests/coach/prompt.test.ts (14 tests) 10ms
✓ tests/coach/streak-jev.test.ts (2 tests) 6ms
✓ tests/coach/streak-runner.test.ts (14 tests) 8ms

Test Files  5 passed (5)
Tests       217 passed (217)
Duration    233ms
```
