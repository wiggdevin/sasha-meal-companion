# Coach live pass rerun 2 after #199, #200, #204, #206, #208, #210 — 2026-10-17 (W087)

Question: how far did the 40-turn streak move after the coach follow-ups merged since rerun B (main `2eef962f`)? Merged since then: #199 (corpus relative date, yogurt and tofu cases), #200 (log failing tool and argument paths on a fallback), #204 (streak runner nits), #206 (offer a next step when the food-rule check holds back an unchecked food), #208 (every corpus food checkable in the streak seed), #210 (act on plan changes and suggestion counts instead of asking).

Same lane and harness as `2026-10-17-coach-live-pass-rerun.md`: `COACH_PROVIDER=openrouter`, `google/gemini-2.5-flash`, `OPENROUTER_ATTESTED=1`, Supabase branch `coach-eval` (`qudqznmwdjtzkejqjlzm`), test user `coach-streak@meal-companion.test`, seed `20260919`. Production (`fivatgdpuenszxxnijpc`) was not touched. No branch was created, reset or deleted. Nothing ran in CI. No app code changed.

Run label: the streak ran with `COACH_STREAK_RUN_DATE=2026-10-20`. That is a label only. Everything ran on 2026-10-17. Evidence files: `docs/evals/2026-10-20-coach-streak*` and `docs/evals/2026-10-20-coach-live-pass-{bulk,offplan}.json`. Earlier evidence is kept.

## Headline

| | First pass (before #185) | Rerun B (`2026-10-19` files, facets warmed) | This run (`2026-10-20` files) |
|---|---|---|---|
| Turns passed of 40 | 13 | 15 | **17** |
| Best consecutive run | 1 | 6 (turns 33 to 38) | **6** (turns 33 to 38) |
| Streak target (10 in a row) | Not met | Not met | **Not met** |
| Generic "I couldn't work that one out" replies | about 14 of 27 failures; 8 of 34 bulk; 15 of 15 off-plan | 0 | 0 in 40 streak turns; 1 of 34 bulk; 0 of 15 off-plan |
| Provider calls with `finish_reason: length` | 0 of 118 | 0 | 0 of 96 (bulk and off-plan probes) |
| Fallback causes (logged lines) | not logged | `reply_scan` 35 of 35 | `reply_scan` 39, `model_abort` 1, `max_tool_calls` 1 (41 lines: streak 15, off-plan 14, bulk 12) |
| Failed tool calls inside fallback lines (new in #200) | not logged | seen as counts only | `unknown_tool` 21, `search_foods` `invalid_args` 8, `search_foods` `refused` 6, `suggest_options` `invalid_args` 6, `suggest_options` `refused` 1, `compose_meal` `invalid_args` 2 |

Read: the streak moved by two turns (15 to 17). The best run is the same six turns as before (33 to 38), and the 10-in-a-row target is still far off. Three cases that failed in rerun B now pass (`list-remove-watermelon-avoid` at turn 1, `devin-shift-late-30`, `block-weight-trend`: the corpus and seed fixes in #199 and #208 worked). One case that passed in rerun B now fails (`list-eggs-cant-do`, turn 23, run-to-run variance in the model's choice of action). 23 failures remain (25 in rerun B).

The main finding corrects rerun B. Rerun B blamed cold facets for the food-rule gate holding foods back. This run warmed 32 more catalog foods (52 in the catalog now) and the gate still held back the same kind of foods. The logged hold reason is `unchecked_id` for 87 of the 115 held items in all 41 fallback lines (the other 28: `allergen:dairy` 11, `category:simple_sugars` 5, `unverified` 5, `allergen:gluten` 4, `allergen:apple` 3, `rule:contains_soy` 2, `avoid_list` 1). In `lib/server/reply-check.ts` that reason means the model wrote a food name or card id itself, with no search behind it. It is not a missing facet. The failing tool paths in the same lines (21 `unknown_tool`, 14 `search_foods` failures, 7 `suggest_options` failures) fit that: the model calls tools that do not exist or with arguments the schema rejects, then answers from names it never resolved. This is model behaviour on this lane, not a seed or facet gap.

## Setup

1. Worktree `../wt/coach-live-pass-rerun-2`, branch `docs/coach-live-pass-rerun-2`, off `origin/main` (`2eef962f`). `pnpm install --frozen-lockfile --offline`.
2. Branch credentials from `scripts/db-branch.sh env coach-eval`, held in `$TMPDIR` and never printed or committed. The URL was checked to contain `qudqznmwdjtzkejqjlzm` and not the production ref. `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` came from the ambient environment, `GEMINI_API_KEY` from `GEMINI_API_KEY_SASHA`. Same open point as earlier passes: I cannot prove the OpenRouter key is not a production key; it only touched a branch database.
3. The branch was 6 migrations behind main (`20270105140000` to `20270106090200`). Dry run first, then `supabase db push --include-all` against the branch DB URL only. All 6 applied.
4. Seed: the streak seeds the test user on every case (#208 seed). I ran four turns once under a scratch label so the new seed rows existed, deleted that scratch evidence, then ran `scripts/warm-facets.ts --commit` for the test user (cursor file in `$TMPDIR`): 32 foods, 800 questions judged, 0 errors. The catalog on the branch now holds 52 foods (20 were warmed before).
5. A first start of the real run was killed after 4 turns because my driver had not saved the stderr `coach turn fallback` lines. Its evidence was deleted and the run restarted from turn 1 with full logging. The numbers here are from the restart only.
6. The runner stops at each failure until resolved. Each was resolved with `--diagnosis model-behaviour` and a placeholder resolution that points at this file. The diagnosis is a placeholder, not a verdict; the causes are below.

## Streak failure list (23)

| Turn | Case | Cause |
|---|---|---|
| 4 | suggest-small-snack-wish | Gate hold, 0 cards. "Couldn't check Egg whites, Banana and Avocado". |
| 5 | block-search-greek-yogurt-eats | Correct dairy rule reply; no food_search block. Expectation (#199 yogurt case) still wants a block of the search kind with intent `avoid`, got none. |
| 6 | devin-five-eats-suggestions | Model asked "what kind of meal" instead of suggesting 5. (#210 did not change this one.) |
| 7 | devin-remaining-snack | Gate hold, 0 cards. |
| 10 | block-three-dinner-ideas | Gate hold, 0 cards (Salmon, Rice, Shrimp). |
| 11 | meals-p4-spaghetti-snack | "Spaghetti has gluten, which your rules exclude". Seed rule refuses the log the corpus expects. |
| 12 | block-protein-or-fibre | Model asked "what would you like to change about your breakfast" instead of quick replies. |
| 13 | block-week-review | Model offered a chart instead of showing it. |
| 15 | suggest-chicken-wrap-wish | Gate hold, 0 cards. |
| 17 | jev-three-dinner-ideas | Gate hold, 0 cards. |
| 18 | block-search-watermelon-avoid | "Watermelon, raw is on your Avoid list". Reply is right, but no food_search block with intent `avoid`. |
| 19 | jev-tiny-rice-log | Extra `delete_entry` action and a next-action chip on a 1 g log. |
| 21 | jev-low-fodmap-unverified | Gate hold ("Mystery broth, Rice and Chicken"); no recipe saved. |
| 22 | jev-log-soy-mark | Soy rule reply, no logged meal with a soy mark. Expectation conflicts with the seeded soy rule. |
| 23 | list-eggs-cant-do | **New.** Two `remove_from_eats` actions ("Eggs are no longer favored") instead of `add_to_avoid`. Passed in rerun B. |
| 24 | suggest-no-cook-recipes-wish | "I cannot find any recipes without cooking". The test user has no recipes. Seed gap. |
| 25 | jev-recipe-excludes-soy | Soy reply, then gate hold on smoked tofu, rice, avocado. No recipe saved. |
| 26 | meals-p2-future-breakfast | "No meal planned for breakfast a week from today": the plan was read, but there is no future plan to materialise. |
| 27 | meals-p6-weekday-oatmeal | Gate hold on oatmeal and blueberries, with a next step ("Add oatmeal and blueberries to your Eats", the #206 offer). No `set_slot_meal`. |
| 29 | suggest-three-dinners | Gate hold, 0 cards. |
| 30 | meals-p1-month-breakfast | "Your food rules or Avoid list block" sourdough toast. No `set_slot_meal`. |
| 32 | meals-p3-next-tuesday-lunch | Gate hold on chicken and rice, with the #206 next step. No `set_slot_meal`. |
| 39 | list-remove-watermelon-avoid | Gate hold: "couldn't check Watermelon, raw". Turn 1 of the same case passed in this run, so the outcome varies by run. |

Grouped: 11 turns end in a gate hold (4, 7, 10, 15, 17, 21, 25, 27, 29, 32, 39); 6 are corpus or seed conflicts, or missing seed data (5, 11, 18, 22, 24, 30); 3 are the model asking or offering instead of acting (6, 12, 13); 3 are single cases (19 over-acts, 23 picks the wrong action, 26 has no future plan seeded).

## Top remaining failure causes

1. **Gate hold from unsearched food names (`unchecked_id`), 11 of 23 failures.** 87 of 115 held items across all fallback lines. The model names foods it never resolved through `search_foods`, or its tool calls fail first (21 `unknown_tool`, 14 `search_foods` failures). Fixing facets will not help. A prompt or tool-schema fix that makes the model search before it names a food is the next win. #206's next step shows up in turns 27 and 32 but not in the suggestion cases (4, 7, 10, 15, 17, 29), which still end "Ask me for something else".
2. **Corpus and seed conflicts, 6 failures** (5, 11, 18, 22, 24, 30). The coach reply is correct for the seeded rules (dairy, gluten, soy, Avoid list, sourdough blocked), but the case expects an add, a log or a block of a different kind. These need corpus fixes, not coach fixes: pick a food the seed allows, or drop the rule for the case, and seed recipes for `suggest-no-cook-recipes-wish`.
3. **The model asks or offers instead of acting, 3 failures** (6, 12, 13). #210 moved the plan-change turns toward a next step (27, 32 now end with an offer), but `devin-five-eats-suggestions`, `block-protein-or-fibre` and `block-week-review` still ask or offer. Turn 23 (wrong action, `remove_from_eats` twice) and turn 19 (over-acting) are related run-to-run model variance.

## Bulk and off-plan (after warming)

| | Value |
|---|---|
| Off-plan turns | 15 (5 prompts, 3 repeats) |
| Off-plan generic abort replies | 0 |
| Off-plan replies | 7 rule blocks (apple, dairy, gluten, sugars), 7 "couldn't check X", 1 normal |
| Off-plan prompt leaks | 0 findings in 15 |
| Off-plan slowest turn | 6.8 s (median 3.4 s); no hang |
| Off-plan fallback lines | 14, all `reply_scan`; held: `allergen:dairy` 10, `category:simple_sugars` 5, `unchecked_id` 5, `allergen:apple` 3, `allergen:gluten` 3, `unverified` 2 |
| Bulk turns | 34 |
| Bulk replies | 22 normal, 10 "couldn't check", 1 generic abort (turn 3, `model_abort`), 1 "couldn't pin that one down" (turn 30, `max_tool_calls`, 14.3 s, the slowest turn) |
| Bulk fallback lines | 12: `reply_scan` 10, `model_abort` 1, `max_tool_calls` 1; held `unchecked_id` 47; `unknown_tool` 15 |
| Provider calls in these two runs | 96, all `finish_reason: stop`; largest completion 415 tokens |

The off-plan replies now name the food rule that applies (7 of 15), which is the useful answer for those prompts. The hidden-foods text from earlier runs did not appear in bulk. The generic abort came back once in bulk (turn 3); `abortCorrected` was `true` on that line, so the send-it-back-once path ran and the model still aborted.

## Spend

Check before and after, from the key's own counter (`/api/v1/key`, shared with other work, so an upper bound):

| | `usage` total | `usage_daily` |
|---|---|---|
| Before (start of run) | $235.482 | $1.401 |
| After the streak | $235.620 | $1.539 |
| After off-plan and bulk | $235.739 | $1.658 |

Total for this run: about $0.26, including the 4-turn scratch run, the killed 4-turn start and the 40-turn streak. That is well under the $3 stop line. The probe calls cost $0.13 (bulk $0.100, off-plan $0.030). Jev (TypeSafe) calls for the facet warm (800 questions) and the verifier are metered separately and were small.

## Follow-ups (no code changed here)

1. Make the model search before it names a food (prompt or tool schema), and reduce `unknown_tool` and `search_foods` `invalid_args` calls. This is the biggest block (11 failures, 87 held items). The #200 log fields name the tool and kind, but the nested `args` print as `[Array]` in the console, so the exact failing argument path is not readable from stderr. Log the paths as a joined string.
2. Corpus fixes: `block-search-greek-yogurt-eats`, `block-search-watermelon-avoid`, `meals-p4-spaghetti-snack`, `jev-log-soy-mark`, `meals-p1-month-breakfast` need foods the seed allows or the right expected block kind; `suggest-no-cook-recipes-wish` needs seeded recipes; `meals-p2-future-breakfast` needs a future plan seeded.
3. Add the #206 next step to the suggestion-card hold ("Ask me for something else and I'll check it first" remains in turns 4, 7, 10, 15, 17, 29).
4. Backlog: B051 and B121 stay open. The streak is still not clean.

## Files

- `docs/evals/2026-10-20-coach-streak.md`, `-state.json`, `-turns/`
- `docs/evals/2026-10-20-coach-live-pass-bulk.json`
- `docs/evals/2026-10-20-coach-live-pass-offplan.json`
