# Coach live pass rerun after #185 — 2026-10-17 (W087)

Question: did #185 ("log turn fallbacks and stop discarding valid answers", main `e7f54f9b`) improve the coach streak? Same lane, branch and harness as `2026-10-17-coach-live-pass.md`: `COACH_PROVIDER=openrouter`, `google/gemini-2.5-flash`, `OPENROUTER_ATTESTED=1`, Supabase branch `coach-eval` (`qudqznmwdjtzkejqjlzm`), test user `coach-streak@meal-companion.test`. Production (`fivatgdpuenszxxnijpc`) was not touched. Nothing ran in CI. No code changed.

## Headline

| | First pass (before #185) | Rerun A (`2026-10-18` files) | Rerun B (`2026-10-19` files, facets warmed) |
|---|---|---|---|
| Turns passed of 40 | 13 | 14 | 15 |
| Best consecutive run | 1 | 6 (turns 33 to 38) | 6 (turns 33 to 38) |
| Streak target (10 in a row) | Not met | Not met | Not met |
| Generic "I couldn't work that one out" replies | about 14 of 27 failures; 8 of 34 bulk; 15 of 15 off-plan | 0 | 0 |
| Provider calls with `finish_reason: length` | 0 of 118 | 0 | 0 |

Read: #185 removed the generic abort text completely (0 in 40 + 40 streak turns, 34 bulk turns and 15 off-plan turns). The pass count moved only from 13 to 14 or 15, and the 10-turn target is still far off. The failures changed cause. They are now food-rule gate replies, not malformed JSON.

Note on the run labels. The harness accepts only `YYYY-MM-DD` for `COACH_STREAK_RUN_DATE`, so `2026-10-17b` was refused. The reruns use `2026-10-18` (A) and `2026-10-19` (B) as labels only. Both ran on 2026-10-17. Evidence files: `docs/evals/2026-10-18-coach-streak*`, `docs/evals/2026-10-19-coach-streak*`, `docs/evals/2026-10-19-coach-live-pass-{bulk,offplan}.json`. The first-pass evidence is kept.

## Setup

1. Branch credentials: `scripts/db-branch.sh env coach-eval` (as in #179), held in the scratch directory, never printed or committed. `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` came from the ambient environment (ZS Vault sourced). `GEMINI_API_KEY` was set from `GEMINI_API_KEY_SASHA`. Same open question as the first pass: I cannot prove the OpenRouter key is not a production key; it only touched a branch database.
2. Branch schema was 7 migrations behind main (`20270104120000` to `20270105130000`). After a dry run with `--include-all` (the older `coach_save_turn` migration sorts before the branch head, so the flag is required), I ran `supabase db push --include-all` against the branch DB URL only. No branch was created, reset or deleted.
3. Rerun A ran with the facet cache as left by the first pass. Before rerun B I ran `scripts/warm-facets.ts --commit` for the test user: 20 catalog foods, 2 cold, 50 questions judged, 0 errors. The branch catalog holds only 20 foods.
4. The runner stops at each failure until it is resolved. Each failure was resolved with `--diagnosis model-behaviour` and a resolution that points at this file (the first pass did the same). The recorded diagnosis is a placeholder, not a verdict. The real causes are below.
5. Each streak invocation runs one turn; a small loop script drove the 40 turns. The OpenRouter per-user limit did not trip (the runner clears `rate_limits` per case).

## Abort-reason tally (from the #185 log line `coach turn fallback`)

Counts across both streak reruns, the off-plan run and the bulk run. The log for turn 1 of rerun A was not saved (it was `reply_scan`, held `unverified`), so it is counted in the line totals but not in the policy-code counts below.

| Source | Fallback lines | Cause |
|---|---|---|
| Streak rerun A (40 turns) | 8 (+1 for turn 1) | all `reply_scan` |
| Streak rerun B (40 turns) | 7 | all `reply_scan` |
| Off-plan (15 turns) | 15 | all `reply_scan` |
| Bulk (34 turns) | 4 | all `reply_scan` |

- Cause `reply_scan` is the only one seen: 35 of 35 saved lines, and the one unsaved line was the same. There were 0 schema refusals, 0 JSON parse failures, 0 timeouts and 0 model aborts that stayed uncorrected. `abortCorrected` was `false` on every line, so the "send the abort back once" path never fired. That is consistent with the first-pass cause guess being wrong: the generic text was the food-rule re-ask falling back, not malformed model JSON.
- Policy codes the re-ask held back, per food item across all fallback lines: `unverified` 31, `unchecked_id` 10, `allergen:dairy` 6, `rule:contains_soy` 4, `category:simple_sugars` 3, `allergen:apple` 3.
- Tool trouble appears inside some turns (`failedToolCalls` and `invalidToolArgs` of 1 to 6 on a few lines, for example the bulk turn with `failedToolCalls: 3`, and a `search_foods` run with `failedToolCalls: 6`). The turn still ended in `reply_scan`. These are worth a look, but they are not the dominant cause.

So the top abort reason is the food-rule gate holding back foods with no verified facet (`unverified` and `unchecked_id`): 41 of the 57 held items. The coach then answers "I couldn't check X against your food rules yet, so I left it out" or "Some foods are hidden until their labels are checked". Warming the 20 catalog foods did not change this: watermelon, spaghetti, chicken, rice, avocado, cheddar, pizza, croissant and similar foods are not in that 20-food catalog, so their facets stay cold on the branch. The gate is working as designed; the branch has no verified facets for the foods the corpus asks about.

## Streak detail

### Compared with the first pass (same 40-turn seed 20260919)

- Fixed in both reruns: `list-eggs-cant-do`, `list-add-tofu-eats`, `jev-role-advice-unconfirmed`.
- New failures in both reruns (passed in the first pass): `block-weight-trend` (reply "No weigh-ins yet.", no chart block; the branch user has no weigh-ins, so the corpus expectation needs a seeded weight), `devin-shift-late-30` (the shift action was taken and the reply is right; the C11 assertion fails, so check the assertion against date drift: the plan date is 2026-10-17 and the run happens on that day).
- Differs between reruns: `list-restore-salmon-eats` failed in A ("couldn't check Salmon, cooked") and passed in B.
- Failing in all three runs: 22 cases (list below). Most are the unverified-food gate, the hidden-foods gate, a seed gap or a clarifying question.

### Rerun B failure list (turn, case, cause)

| Turn | Case | Cause |
|---|---|---|
| 1 | list-remove-watermelon-avoid | Food-rule gate: "couldn't check watermelon". Seed has no watermelon on the avoid list, and the facet is cold. |
| 4 | suggest-small-snack-wish | Hidden-foods gate, 0 cards. |
| 5 | block-search-greek-yogurt-eats | Correct rule block (dairy), but the corpus expects add to Eats. Corpus expectation conflicts with the seed's dairy rule. |
| 6 | devin-five-eats-suggestions | Model asked what kind of meal instead of suggesting. |
| 7 | devin-remaining-snack | Hidden-foods gate, 0 cards. |
| 8 | devin-shift-late-30 | C11 assertion; the action itself worked. See above. |
| 9 | block-weight-trend | No weigh-ins seeded; no chart. |
| 10 | block-three-dinner-ideas | Hidden-foods gate, 0 cards. |
| 11 | meals-p4-spaghetti-snack | Food-rule gate: "couldn't check spaghetti". |
| 12 | block-protein-or-fibre | Model asked "which meal do you mean by breakfast" instead of quick replies. |
| 13 | block-week-review | Model offered a chart instead of showing it. |
| 15 | suggest-chicken-wrap-wish | Food-rule gate: "couldn't check chicken". |
| 17 | jev-three-dinner-ideas | Hidden-foods gate, 0 cards. |
| 18 | block-search-watermelon-avoid | Wrong food-search intent (`log`, not `avoid`) and an extra chip. Model behaviour. |
| 19 | jev-tiny-rice-log | Extra next-action chip on a 1 g log. |
| 21 | jev-low-fodmap-unverified | No recipe found; "shared recipe discovery is not available for this account". Seed gap. |
| 22 | jev-log-soy-mark | Correct soy rule block, but the corpus expects a logged meal with a soy mark. Needs a seeded, verified tofu facet. |
| 24 | suggest-no-cook-recipes-wish | Model asked what kind of recipes. The test user has no recipes. |
| 25 | jev-recipe-excludes-soy | Soy rule block, then "couldn't check rice and avocado". Cold facets. |
| 26 | meals-p2-future-breakfast | Reads the plan for 5 October (no meal planned). Corpus date drift. |
| 27 | meals-p6-weekday-oatmeal | Model asked for amounts instead of acting. |
| 29 | suggest-three-dinners | Hidden-foods gate, 0 cards. |
| 30 | meals-p1-month-breakfast | Could not find "sourdough toast" and others; asks what to log them as. Cold facets or catalog gap. |
| 32 | meals-p3-next-tuesday-lunch | Model asked for amounts instead of acting. |
| 39 | list-remove-watermelon-avoid | Same as turn 1. |

Rerun A had the same list plus `list-restore-salmon-eats` (turn 14), and rerun B added nothing new. Per-turn proof files hold the assertions.

## Bulk and off-plan (rerun B, after warming)

| | Value |
|---|---|
| Off-plan turns | 15 (5 prompts, 3 repeats) |
| Off-plan replies that were the generic abort text | 0 (was 15 of 15) |
| Off-plan replies | 12 "couldn't check X against your food rules yet", 3 rule blocks (dairy, apple, sugars category) |
| Off-plan prompt leaks | 0 findings in 15 |
| Off-plan slowest turn | 5.8 s (was 12.4 s); no hang |
| Bulk turns | 34 |
| Bulk replies | 25 normal answers, 5 hidden-foods, 2 "couldn't check", 2 "couldn't pin that one down" |
| Bulk generic abort replies | 0 (was 8 of 34) |
| Provider calls in these two runs | 113, all `finish_reason: stop`; largest completion 486 tokens |

The off-plan check is still not useful to the user: the coach now says why it left the food out, which is an improvement, but it does not answer the request. Cause: cold facets for foods outside the 20-food catalog.

## Spend

OpenRouter key usage (the key's own `usage_daily` counter, which is shared with other work, so this is an upper bound): rerun B, off-plan and bulk together moved it from $1.157 to $1.392, so about $0.24. The provider calls recorded by the probes cost $0.14 (bulk $0.124, off-plan $0.016). Rerun A was not measured separately; it is a run of the same size as B, so about $0.1 to $0.2. Estimated total: under $0.6 against the $3 stop line. Jev (TypeSafe) and Gemini direct calls are metered separately and were small.

## Follow-ups (no code changed here)

1. Seed or warm facets for the foods the corpus uses (watermelon, spaghetti, chicken, rice, avocado, cheddar, pizza, croissant, bacon, sourdough, salmon, tofu), so the food-rule gate can run on them. This is the largest single block of failures (about 11 turns plus all off-plan replies). Check first why those foods are outside the catalog: the branch catalog has 20 rows, while the corpus assumes a fuller one.
2. When the gate holds back the only requested food, the coach should say what it needs and offer a next step (for example "add it to Eats to check it"), not only "ask me for something else". A `reply_scan` fallback with every requested food held is the normal outcome of the gate, so it may deserve its own log cause, apart from real scan failures.
3. Corpus fixes, not coach fixes: `block-weight-trend` needs a seeded weigh-in; `meals-p2-future-breakfast` has a hard-coded date that drifted; `list-remove-watermelon-avoid` needs watermelon on the seed avoid list; `block-search-greek-yogurt-eats` and `jev-log-soy-mark` expect an add or log that the seed's own dairy and soy rules refuse; `suggest-no-cook-recipes-wish` needs seeded recipes; `devin-shift-late-30` needs a look at the C11 assertion.
4. Clarifying-question turns (`devin-five-eats-suggestions`, `block-protein-or-fibre`, `meals-p3-next-tuesday-lunch`, `meals-p6-weekday-oatmeal`): the model asks instead of acting. Decide if the prompt should push a default (assume the usual amount) for these.
5. Tool-call noise: a few turns show 3 to 6 `failedToolCalls` or `invalidToolArgs` before reaching `reply_scan`. Log which tool and which arg fails, so these can be told apart from the gate.
6. The runner's `--resolve` takes the next argument as the failure id, so `--resolve --diagnosis ...` without an id fails with "No matching open failure". Pass `--resolve F001`. A one-line usage note in the header of `scripts/eval/coach-streak.ts` would help.
7. `COACH_STREAK_RUN_DATE` rejects suffixes such as `2026-10-17b`. Either allow a suffix or say so in the header.
8. Backlog: B051 and B121 stay open. The streak is still not clean, but the failure mix is now readable, and the next win is a facet and seed fix, not a model swap. The pin question from the first pass (stay on gemini-2.5-flash?) has less weight now: the malformed-JSON rate that prompted it was not the cause.
