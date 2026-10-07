# Coach deflection: the review log and the corpus process

Ruling 9, `docs/decisions/2026-09-12-wave4-rulings.md`. `classifyMedical` (`lib/coach/deflect.ts`)
is a pattern matcher: it will both miss real medical questions and over-deflect safe ones (spec
`docs/specs/phase-7-coach.md` open questions 5–6). This is the process for reviewing that, instead
of tuning the matcher from guesses.

## The corpus is the only review log

`lib/coach/fixtures/injection-corpus.ts` is the single record of what the deflector has been
checked against — 42 adversarial cases today, each `{ input, expected }`. There is no separate
findings doc, ticket queue or spreadsheet: a case that is not in the corpus has not been reviewed.

## Adding a case

1. When a miss (a medical question that was not deflected, or a safe question that was) turns up
   — on Devin's phone during the manual gate below, or from a future live canary — add it to
   `injection-corpus.ts` as `{ input, expected }` with the outcome it should have produced.
2. Land the new row in the **same PR** as whatever else prompted the finding; do not batch corpus
   fixes separately from the code that found them.
3. Re-run the stub suite: `pnpm vitest run tests/coach/injection.test.ts`. It must stay green — a
   new row that fails is either a real regression (fix the matcher) or a wrong expectation (fix
   the row), and the PR does not land carrying a red corpus test either way.

## Stub suite vs. live canary

- **Stub suite** (`tests/coach/injection.test.ts`, in CI): replays the corpus against a stubbed
  model. This is the merge gate — every PR runs it, and it must pass.
- **Live canary** (`scripts/coach-injection-canary.ts`, outside CI): replays the corpus against
  whichever live model `coachProvider()` / `coachModelId()` in `lib/server/coach.ts` resolves — the
  **non-health routed target**, Gemini `gemini-3.6-flash`, since Nous is rejected for the coach
  (ruling 1) and no branch of `lib/ai/route.ts` names it. A real Sasha turn is health-context (her
  profile carries ulcerative colitis), so it routes only when both R4 variables are set
  (`HEALTH_CONTEXT_PROVIDER=gemini` + `GEMINI_BILLING_ATTESTED=1`); with either unset it returns
  `503 nous_unconfirmed` and reaches no model. The canary's target is therefore the non-health
  target, not the answer a real turn would get.
  **No live canary runs until the coach flags (`COACH_ENABLED` / `NEXT_PUBLIC_COACH_ENABLED`) are
  on** — Gemini billing and prompt logging were attested in the console on 2026-09-12
  (`docs/ai-data-handling.md`, Attestation), and the canary still waits on the T9 flag flip
  (ruling 9). Each time the live canary does run, commit a dated Coach canary receipt in this
  directory.

The production-enablement run on 2026-09-13 pinned Coach and weekly review to
`gemini-3.6-flash` after 3.8 and 3.7 exhausted their retry budgets with `503 high demand`.
The 3.6 live result is recorded in `docs/coach-canary-2026-09-13.md` (42/42 passed).

## Where this plugs into the manual gate

The phone-side manual gate in `docs/specs/phase-7-coach.md` ("Manual gate Devin runs on the
phone") is where a real miss first surfaces, since it runs against her actual data instead of the
corpus. Anything found there follows the same rule as a canary miss: it becomes a corpus row with
its expected outcome, in the PR that fixes it, and the stub suite stays the gate.
