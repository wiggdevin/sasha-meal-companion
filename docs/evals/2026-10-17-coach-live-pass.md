# Coach live quality and privacy pass — 2026-10-17 (W087)

Lane under test: `COACH_PROVIDER=openrouter`, `google/gemini-2.5-flash` (fallback `google/gemini-3-flash-preview`), `OPENROUTER_ATTESTED=1`. Target: the persistent Supabase branch `coach-eval` (`qudqznmwdjtzkejqjlzm`) with the branch test user `coach-streak@meal-companion.test`. Production (`fivatgdpuenszxxnijpc`) was never touched. Nothing ran in CI.

## Summary

| Done-when item | Result |
|---|---|
| All-category streak reaches 10 consecutive passes | No. Exhausted at 40/40 turns, best streak 1/10. 27 failures filed below, each with a cause guess. |
| Share of replies cut by the token cap, over at least 30 live turns | 0 of 118 provider calls (61 turns). 0 ended with `finish_reason: length`. Largest reply was 287 completion tokens. |
| Off-plan prompt-leak and 3-minute hang re-run | No leak, no hang (slowest turn 12.4 s). But all 15 off-plan replies were the generic "I couldn't work that one out" text, so the check is clean and the coach is still not useful on those requests. |
| Live F10 health-context prompt-log check, non-production key, branch user | Pass. See F10. |
| B071 production exchange | Dropped. Replaced by the branch exchanges above. |
| B069 and B071 marked superseded | Done in `docs/plans/2026-10-10-work-graph/backlog.json`. The streak itself is not clean, so the quality gap is recorded here and not hidden behind the supersede. |

## Setup deviations (read these first)

1. **Branch schema was 17 migrations behind** (`PGRST202 ai_spend_reserve_split` missing). I ran a dry run, then a forward `supabase db push` of exactly those 17 committed migrations to `coach-eval`. This is not a create, reset or delete. Nothing else changed on the branch.
2. **Runner fix, `scripts/eval/coach-streak.ts`.** Before each case it now deletes the test user's `rate_limits` rows. The per-user limit of 10 coach turns an hour tripped at turn 10 of the first run and filled the rest with 429s. That is the limiter working, not a coach defect. The first run was discarded.
3. **Date override, new `scripts/eval/coach-streak-run-date.ts`.** `COACH_STREAK_RUN_DATE` (YYYY-MM-DD) starts a fresh run with its own state, report and turn files, so the 2026-09-19 evidence is not overwritten. Unset keeps the old behaviour. (Both changes sit outside the 400-line-capped harness and state modules.)
4. **Jev facet cache warmed** with `scripts/warm-facets.ts` before the valid run. Without it the Jev cases hit a soy-cache block.
5. **Probe script `scripts/eval/coach-live-pass.ts`** (new). Modes `bulk`, `offplan`, `f10`, `diag`. It wraps the OpenRouter fetch to read `finish_reason`, token usage and cost per call, clears this test user's rate limits and chats between turns (the 8-chat cap is per user), and never writes a secret. Raw dumps are opt-in through `COACH_LIVE_PASS_DUMP` and `COACH_LIVE_PASS_RAW`, to scratch paths.
6. **Key provenance.** The OpenRouter key came from the main checkout's `.env.local` through the environment. I cannot prove from here that it is not the production key; the run is non-production in the sense that it used a branch database and a fake test user, and nothing from production was read or written. Devin should confirm the key's identity if "non-production key" must be literal.

## Streak result

State file: `docs/evals/2026-10-17-coach-streak-state.json`. Report: `docs/evals/2026-10-17-coach-streak.md`. Per-turn evidence: `docs/evals/2026-10-17-coach-streak-turns/`.

13 of 40 turns passed, best consecutive run 1. The earlier 2026-09-19 run on the older lane ended 3/10.

### Failure list with cause guesses

Dominant cause (about 14 of 27): the **generic abort text** "I couldn't work that one out". The provider call finishes with `stop` (50 to 350 tokens), so this is not truncation. Raw responses from the diag mode show the model returning the flat turn JSON malformed: `final` steps with empty placeholder actions (`item.name: ""`, `grams: 0`), or `tool` steps whose `args` are split into garbage objects. The turn schema rejects those and the turn falls back to the generic abort. Cause guess: gemini-2.5-flash on OpenRouter does not follow the flat turn schema reliably. Label: model behaviour on this lane. The abort reason is not logged anywhere, which made this slow to find.

| ID | Turn | Case | Cause guess |
|---|---|---|---|
| F001 | 1 | list-remove-watermelon-avoid | Run-dependent. Malformed flat JSON (generic abort), or a correct "not on your avoid list" reply because the seed avoid list has no watermelon. The corpus case may need a seed that contains it. |
| F002 | 4 | suggest-small-snack-wish | "Some foods are hidden until their labels are checked": the suggestion gate hid every card; 0 cards. Thin seed catalog plus unverified foods. |
| F003 | 5 | block-search-greek-yogurt-eats | Generic abort (malformed output). |
| F004 | 6 | devin-five-eats-suggestions | Model asked a clarifying question instead of suggesting. |
| F005 | 7 | devin-remaining-snack | Generic abort (malformed output). |
| F006 | 10 | block-three-dinner-ideas | Same hidden-foods gate as F002; 0 cards. |
| F007 | 11 | meals-p4-spaghetti-snack | Generic abort. The model emitted a garbled `search_foods` tool step. |
| F008 | 12 | block-protein-or-fibre | Model asked what to change instead of offering quick replies. |
| F009 | 13 | block-week-review | Model offered a menu of charts instead of showing the kcal week chart. |
| F010 | 14 | list-restore-salmon-eats | Generic abort. The model emitted an empty-placeholder `add_to_eats` action. |
| F011 | 15 | suggest-chicken-wrap-wish | Generic abort (malformed output). |
| F012 | 17 | jev-three-dinner-ideas | Hidden-foods gate; 0 cards. Ranking call count is also off (2 coach calls plus 1 verify). |
| F013 | 18 | block-search-watermelon-avoid | Wrong food-search intent (`log`, not `avoid`) and an extra next-action chip. Model behaviour. |
| F014 | 19 | jev-tiny-rice-log | Extra `delete_entry` action and a chip. Model over-acts on a 1 g log. |
| F015 | 21 | jev-low-fodmap-unverified | Model asked for a recipe name instead of saving. Corpus may be too terse for the `mayReachJev` gate. |
| F016 | 22 | jev-log-soy-mark | Generic abort. |
| F017 | 23 | list-eggs-cant-do | Generic abort. |
| F018 | 24 | suggest-no-cook-recipes-wish | "No recipes fit": the test user has no recipes. Seed gap. |
| F019 | 25 | jev-recipe-excludes-soy | Generic abort. |
| F020 | 26 | meals-p2-future-breakfast | Model read the plan for 5 October and reported no meal planned; the expectation is a future plan that gets materialised. Model behaviour or corpus date drift. |
| F021 | 27 | meals-p6-weekday-oatmeal | Model asked for amounts instead of acting. |
| F022 | 28 | list-add-tofu-eats | Generic abort. The same sentence passed through the fast path in the diag run, so the outcome varies by run. |
| F023 | 29 | suggest-three-dinners | Hidden-foods gate; 0 cards. |
| F024 | 30 | meals-p1-month-breakfast | Generic abort. |
| F025 | 32 | meals-p3-next-tuesday-lunch | Model asked for amounts instead of acting. |
| F026 | 34 | jev-role-advice-unconfirmed | Generic abort. |
| F027 | 39 | list-remove-watermelon-avoid | Same as F001. |

Two suggested follow-ups, not done here:
- Log the abort reason (and a parse-failure code) in the turn path. Today every non-timeout abort shows the same text.
- Decide if gemini-2.5-flash stays as the OpenRouter coach pin, given the malformed flat-JSON rate. A direct Gemini run on the older lane scored 3/10, so this lane is not clearly worse, but it is not close to 10.

## Truncation share

Measured by reading `finish_reason` and `usage` on every OpenRouter response (streamed) in the final probe runs: bulk (34 prompts), off-plan (15), F10 (6) and diag (6).

| | Value |
|---|---|
| Live turns | 61 |
| Provider calls | 118 |
| `finish_reason: length` | 0 (0.0%) |
| Completion tokens at or above the current cap, 3,072 | 0 (0.0%) |
| Completion tokens at or above the old cap, 1,200 | 0 (0.0%) |
| Largest completion | 287 tokens |
| Models seen | `google/gemini-2.5-flash` only (no fallback fired) |

The cap is now 3,072 (raised on 2026-09-15), so the spec's "1,200-token cap" no longer exists. At both thresholds the share is zero. The replies that read as cut off are not truncated; they are the abort and clarifying-question cases above.

## Off-plan prompt leak and hang

Prompts: bagel with cream cheese and apple, cheddar snack, search for pizza, ice cream with honey, croissant with butter and jam. 5 prompts, 3 repeats, 15 turns.

- Leak scan (internal field names, placeholders, JSON fragments, schema words): 0 findings in 15 replies.
- Hang: slowest turn 10.9 s, median 3.5 s. The 3-minute hang did not recur.
- Quality note: 15 of 15 replies were "I couldn't work that one out. Try naming the meal or food you mean." The safe fallback worked; the useful answer did not appear. Same root cause as the streak's dominant failure.
- Bulk run for context: 8 of 34 replies were the same abort text, 1 was "I couldn't pin that one down", 3 were the hidden-foods text.

## F10 health-context prompt-log check

Branch test user profile: weight 60 kg, moderate activity, goal recomp, dietary flags. Plain question: "what should I eat next?".

- Plain question, 4 outgoing provider requests, full prompt text captured: 0 matches for `60 kg`, `weight_kg`, `59.x`, `60.0`, `Profile:`. The `kg` token appears only in the static tool description. Tool results are fenced as untrusted data (`<<untrusted-data>>`). The stored condition text ("colitis") does reach the prompt, as part of the binding constraint profile; that is by design and is what the health-context attestation gate (`OPENROUTER_ATTESTED=1`) exists to allow. Raw weight is the data that must stay out, and it did.
- Positive control at the real context builder (`buildCoachContext` then `renderCoachContext`, same saved profile): with intent `log_weight` the rendered context contains the `Profile:` line and `60 kg`; with a plain question it does not. So the scan can see a profile when the code sends one.
- Honest limit: five free-text control sentences through the live path (weight and target question, calorie question, update profile, weigh-in) also sent no profile line. Free-text intents mostly reach the model path with a null intent, so the profile gate stays closed. The coach answered "your weight is not logged". This is a quality finding, not a privacy one: it errs toward sending less health data.
- Result: pass. Evidence: `docs/evals/2026-10-17-coach-live-pass-f10.json`.

## B071 (production exchange)

Dropped. Agents may not touch production, and the branch run covers the same ground: 61 turns, 118 live provider calls, persisted threads, messages and actions (one `update_profile` write succeeded). Mark superseded.

## Dispositions

| Item | Disposition |
|---|---|
| B051 (streak) | Re-run, not clean. Failures filed above. Keep open for the abort and flat-JSON work. |
| B112 | Truncation measured: 0 of 118. Nothing further from this item. |
| B121 | Live quality measured. Not clean. See the failure list. |
| B069 | Superseded (leak and hang). Quality gap stays here. |
| B071 | Superseded. |

## Spend

Final probe files: about $0.14 (1.14 M prompt tokens, 12.6 k completion tokens on gemini-2.5-flash). Both streak runs, the discarded first run, the earlier probes and the re-runs together are estimated well under $1. Far below the $5 stop line.

## Files

- `/Users/zero-suminc./projects/clients/Sasha/meal-companion/.claude/worktrees/agent-a64fe3371e06b8cba/scripts/eval/coach-live-pass.ts`
- `docs/evals/2026-10-17-coach-live-pass-{bulk,offplan,f10,diag}.json`
- `docs/evals/2026-10-17-coach-streak.md`, `-state.json`, `-turns/`
