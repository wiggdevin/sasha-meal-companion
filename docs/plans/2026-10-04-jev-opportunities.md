# Where Jev helps: working notes (backend lane, from 2026-10-04)

Living notes. Each backend task adds what it learned about where Jev (TypeSafe System One, via
`callModel` → `lib/ai/typesafe.ts`) is a good fit and where it is not. Jev returns typed
judgments and probabilities; it does not write prose and it can be wrong, so every use needs a
deterministic fallback and a confidence threshold.

## Rule of thumb

Use Jev where code needs a **judgment about natural language or fuzzy food data** that would
otherwise be a brittle regex or a full Gemini turn. Do not use it where the answer is a
**fact the database or arithmetic already owns** (sync integrity, target numbers, macro sums).

## Already in production (`lib/ai/call-registry.ts`)

| Purpose | Where | What Jev decides |
|---|---|---|
| `coach-intent` | `lib/coach/intent.ts`, `intent-questions.ts` | Intent + argument confidence; ≥ 0.95 / 0.90 takes the fast path without Gemini |
| `coach-verify` | `lib/coach/verify.ts`, `verify-question.ts` | Does the reply claim an action that did not happen (flag ≥ 0.80) |
| `suggest-options` | `lib/coach/suggest-rank.ts` | Ranks code-built, policy-clean candidates |
| `profile-prefs` | `lib/profile/pref-questions.ts`, `app/api/profile/prefs` | Dietary free text → confirmable chips |
| `meal-component-role` | `lib/coach/role-advice.ts` | Macro role of a meal component |
| `serving_identity` | `lib/log/serving-identity.ts` | Is this serving the same food/portion |
| `log_sanity` | `lib/log/sanity.ts`, `sanity-questions.ts` | Is a logged amount plausible |
| `food_facets` | `lib/foods/facet-warm.ts`, `lib/server/eats-facet-warm.ts` | Food facets for Eats |

## Findings by task

### 1. C5 recipe consumed-history proof (2026-10-04)

- **No Jev fit.** History protection is a database invariant (epochs, a trigger, a private
  state table). A probability has no place in it; the proof is deterministic tests.
- **Possible adjacent fit, not built:** when the guard restores a mark over a device's offline
  tick, the app could explain it ("this meal was undone on another device"). Choosing that
  wording is UI copy, not a judgment, so Jev is still not needed.

### 2. TDEE step E — static → adaptive handoff (2026-10-04)

The estimator itself stays deterministic (ruling R1–R9): every number is arithmetic on intake and
weight, and a probability must never decide a calorie target. Jev fits around it, where the input
is a person's words or a fuzzy judgment about a day:

| Candidate | Judgment | Why Jev, not code or Gemini | Guardrail |
|---|---|---|---|
| **`day_completeness`** (best fit) | Given today's logged slots, entry names and times, P(the day is fully logged). | "No dinner logged", "only coffee by 9 pm" are common-sense calls a threshold misses; a full Gemini turn is too slow for a tap. | A nudge before "Day fully logged" only ("Nothing logged after lunch — mark anyway?"). Never a qualification rule: the user's mark is the evidence. D1 data (food names, times), no health fields. |
| `far_from_seed` explanation | When the review flag fires, which is likelier: under-logging, a wrong profile input (activity, weight), or a real change? | Ranking three plain explanations from the profile fields and recent log pattern is a typed judgment. | Picks the sentence the card shows; changes no number and no flag. |
| Coach "why did my TDEE change?" intent | Route the question to the estimate explainer instead of a generic turn. | Already covered by `coach-intent`; add the intent kind, no new purpose. | Existing thresholds. |
| Under-logging pattern | P(a run of marked days is systematically incomplete) from entry counts per day. | — | **Not recommended:** under-logging is not identifiable from weight and intake (spec E5); a model guess would dress that up as knowledge. |

Next step if Devin wants one: a `day_completeness` purpose in `lib/ai/call-registry.ts` with a typed
payload builder (slots logged, entry count, last entry time, local hour), a 0.80 threshold for the
nudge, and the UI lane showing it beside the mark.
