# Phase 18: Open-world foods, the Favored list and the taste profile

Date: 2026-10-05. Revision 5 (final before owner approval). Owner: the product owner. Status: draft for owner review; nothing here
is built. Base: `main` after PR #392 (Phase 17 O2: occasion history and snapshot v2) and PR #402
(t18: paged safety reads). Depends on Phase 17 O4a (the planner, recipe and slot-clock slice with the
shared occasion-phrase parser, split out of `feat/meals-o4-placement` by the O4 re-plan).

**Sources.** Revision 2 adopted GPT-6 Sol's first model design
(`~/.claude/goal-state/sasha-backend-2026-10-05/phase18/design-1-final.md`) and the Jev role the
owner approved. Revision 3 folds in Sol's second pass
(`~/.claude/goal-state/sasha-backend-2026-10-05/phase18/design-2-final.md`) and the UI lane's
research brief on food-preference priors and food similarity
(`~/Inbox/notes/2026-10-05-food-preference-priors-research.md`, cited as "the brief"). Where the two
passes differ, revision 3 follows the second. Revision 4 fixes the eight findings of the GPT-6 review
of revision 3 (`~/.claude/goal-state/sasha-backend-2026-10-05/reviews/t21r1-sol.md`, last block) and
cites the owner's NHANES ruling (`docs/decisions/2026-10-05-nhanes-aggregate-use.md`). Revision 5
applies the owner's decisions on the second review
(`~/.claude/goal-state/sasha-backend-2026-10-05/reviews/t21r2-sol.md`): a counter-based rules clock,
an evidence clock, the accepted pantry-photo risk, and numeric release gates. This spec is the PRD for a /goal run: §10 is the slice
contract and §9 is the change to the rules that tests guard.

**Honesty labels.** Every constant in this spec is a proposed starting value, not a measurement. No
ranking lift has been measured. No data build, replay or latency benchmark has run. The brief's
**[LOCAL]** counts were computed once from public files and are not recomputed here. Its
**[ESTIMATE]** and **[UNVERIFIED]** items keep their labels in this spec.

## Owner decisions

**Decided:**

| Decision | Source |
|---|---|
| The food world is open by default. Favored foods rank higher and never limit meals. Every eaten ingredient feeds the taste profile, except foods the account's rules exclude. | Owner brief (§1) |
| A named `compose_meal` combination that cannot form a coherent plate returns an incomplete named draft with a reason. It makes no fit claim and adds no foods. | O4 ruling, 2026-10-05 |
| Jev's role: formulas and code do all the scoring. Jev labels food pairs offline, turns free text into chips the user confirms, and runs the short-list check inside a request budget of three logical Jev calls (W089). Jev never sets numbers, never invents dishes, never decomposes dishes, and is never on the rules path (D9). | Owner approval, revision 2 |
| W2 takes Jev off every allergy decision and fails closed: a food that only Jev flagged never becomes clear (D4, W2a). | Coordinator, revision 2 |
| The population prior stops at national → sex by age. It has no region, state or race and ethnicity node. The app never asks, infers or stores race or ethnicity; the survey field is used only in offline fairness audits. State priors and Canada are deferred. | Coordinator, revision 3 |
| The freshness token is two monotonic counters: an account rules clock bumped by database triggers on every rule write, and a global evidence clock bumped on every allergen-evidence or `policy_categories` change (D11). | Owner, revision 5 |
| Pantry photos (W12): user-started capture, a "keep medicines and labels out of frame" notice, zero-retention routing, no profile or rule data, EXIF stripped. The owner accepts in writing the remaining risk that visible pixels in a photo may show health information (2026-10-05). Plan-sheet photos get the same notice as a follow-up. | Owner, revision 5 |
| NHANES aggregates may be used as population priors. The owner read the NCHS data user agreement on 2026-10-05 and approved the use. The ruling is the written use decision. Its four build-pipeline hard rules, plus a fifth rule this spec adds (no race or ethnicity in any shipped output), are acceptance criteria of W1b and W1c. | Owner ruling, `docs/decisions/2026-10-05-nhanes-aggregate-use.md` |

**Needed from the owner** (each with a recommendation; details in §12):

1. Launch geography: a U.S. prior only for users who choose the U.S.? *Recommended: yes; defer
   Canada and states.*
2. Third-party data rights: check FlavorGraph and the UK Biobank liking files, or ship without them?
   *Recommended: ship without FlavorGraph; add the UK Biobank aggregates only after their reuse terms
   are confirmed.*
3. Clinical sign-off: who signs off on universe evidence, cuisine tiers and condition wording?
   *Recommended: the owner for the universe and tiers; a qualified clinical reviewer for condition
   wording.*
4. Conditions: is the user's own confirmation, in reviewed wording, enough to open the world?
   *Recommended: yes, once the clinical reviewer approves the wording; those accounts stay closed
   until then.*
5. Existing accounts: who gets the open-world invitation, and when? *Recommended: keep the first
   client held; invite others after the safety and plausibility gates pass; keep their Eats marks as
   Favored when they opt in.*
6. Offline safety: show the last plan but withhold new suggestions until the rule revision is fresh?
   *Recommended: yes.*
7. Cross-user learning (T3)? *Recommended: keep it out of scope.*
8. Shopping gate: ship W11 and W12 beyond the pilot? *Recommended: keep both pilot-only until the
   shared score and the confirm-first pantry flow pass their release checks.*

## 1. What the owner asked for

Kept close to the owner's words:

1. Every meal the user eats stores all its ingredients to the user's list. Exceptions: an
   ingredient the user marked "do not eat" (Avoid), and an ingredient that a condition or disease
   makes unfit for the user. Allergens and banned categories count as such exceptions.
2. Otherwise, assume the user can eat everything else. The food world is open by default.
3. A shopping list the user actually uses sends its ingredients to the user's yes list, and they are
   favored for recipes and meals. The user can say "use my shopping list", and those foods are
   favored as much as possible.
4. Count how many times the user eats each ingredient. More times means a stronger preference. Use
   machine-learning techniques to find a personal taste profile as the user uses the app more.
5. Onboarding gets a cuisine question. The most commonly eaten ingredients of the chosen cuisines
   become fair game, sorted by preference, sensitivities and allergies.
6. Build a strong recommendation plan from sex, location, goals, favored cuisines and what the user
   does not eat. All the other top foods stay available until the user says otherwise.
7. Rename the allow list (Eats) and repurpose it as a Favored list. A Favored food is favored in
   meals and recipes. Favored never limits meals to its foods.
8. The user can photograph the fridge or pantry. The recognised ingredients go into the pantry and
   are used, that is, favored.

## 2. Today's model, verified in code

### 2.1 The owner's premises

| Premise | Verdict | Evidence |
|---|---|---|
| Generated layouts draw only from marked Eats rows, filtered by policy. | True. | The server reads only `status = 'eats'` rows, paged since t18 (`lib/server/eligible-foods.ts:74-81`), and clears a ref only when the policy allows it AND it is on Eats (`lib/server/eligible-foods.ts:127-132`). The phone keeps only Eats foods (`lib/foods/eligible-client.ts:90-111`), and the engine pool is Eats with usable nutrition (`lib/meals/pool.ts:26-37`). `resolveDay` passes only verified Eats to the layout (`lib/resolve.ts:109-127`). |
| Suggestions draw only from Eats. | True for anchors. | A card anchors only on an Eats protein (`lib/coach/suggest-candidates.ts:19-22`, `:304-306`). An account with no Eats gets `NO_SAVED_FOODS` (`lib/coach/suggest-candidates.ts:56`, `:80`). |
| `compose_meal` draws only from Eats. | **Partly wrong.** | A named food is searched first under the user's own Eats name, then in the whole catalog (`lib/coach/compose.ts:256-261`). Only the food the composer ADDS for a missing macro comes from Eats (`lib/coach/compose-complement.ts:1-3`, `lib/coach/compose.ts:292-325`). |
| Swaps draw only from Eats. | True. | Generated rows come from the same engine; saved meals and recipes appear only when every ingredient is still on Eats (`lib/today/swap-alternatives.ts:29-40`). |
| Recipes draw only from Eats. | **Wrong.** | Recipes are already open-world. Eligibility runs the policy with `onEatsList: false` (`lib/recipes/eligibility.ts:124`), and no Eats ranking is used (`lib/server/recipe-candidates.ts:182-191`). An unused hook gives 0.25 per "usual" ingredient (`lib/recipes/candidates.ts:63`); every caller passes an empty list (`lib/server/recipe-candidates.ts:190`, `:252`). |
| Starter foods are seeded once at onboarding. | Partly. | `STARTERS` holds 40 foods, 29 marked `default` (`lib/foods/starter.ts:18-62`). The onboarding Foods step shows only for accounts without recipe access (`components/Onboarding/OnboardingFlow.tsx:373-387`). The automatic seed runs later, on Today, for the same accounts (`lib/foods/today-starter.ts:45`). "Once" is a per-device localStorage marker plus a remote "already has foods" check, with no database flag (`lib/foods/starter-seed.ts:13`, `:16-26`, `:50-60`). |
| `favorites_foods` exists as a star. | True. | Table at `supabase/migrations/20260911000200_user_schema.sql:45-47`; the Foods star writes it (`components/MyFoods.favorites.ts:72-77`, `:112`). No layout, suggestion or compose path reads it. Only the recipe loader reads it, as +1 per matching ingredient (`lib/server/recipe-candidates.ts:144-145`, `lib/recipes/candidates.ts:62`). |
| Pantry and shopping exist under `lib/shopping/*`. | True, and pilot-gated. | Every shopping route calls `requireRecipeUser`, which checks `RECIPE_PLANNING_USER_IDS` (`lib/server/recipe-access.ts:8-25`). Lines carry `origin`, `checked`, `note` and an identity inside JSON (`supabase/migrations/20261127090000_recipe_catalog_shopping.sql:213-230`). The pantry has nullable grams and `confirmed_at`, and no source, unit or expiry column (`supabase/migrations/20261127090000_recipe_catalog_shopping.sql:257-264`). The planner reads the pantry for stock but not for its score (`lib/shopping/planner.ts:100-126`). |
| Photo capture exists. | True, and a fridge photo already works. | `photoToItems` returns items with grams (`lib/ai/schemas.ts:20-23`). `photoToIdeas` already has an "ingredients" kind for "a fridge, pantry, counter or groceries" that returns names only (`lib/ai/inspire.ts:22`). Nothing writes those names to the pantry; they become a coach planning turn. |
| Food role advice uses Jev. | True. | One `choice` question over six roles (`lib/coach/role-advice.ts:57-61`). Advice never persists without `POST /api/foods/role/confirm` (`app/api/foods/role/confirm/route.ts:10-25`). |
| The policy engine is fail-closed. | True, with three caveats. | No allergen evidence returns "Check the label" as `unknown` (`lib/policy/allergens.ts:381-382`). An unknown or unreadable verdict hides a suggestion (`lib/coach/suggest-verdict.ts:48-50`, `:98-104`, `:114-116`). **Caveat 1:** with no active allergen rule, an Eats mark clears the "no ingredient evidence" gate (`lib/policy/constraints.ts:188-191`). **Caveat 2:** a diagnosis activates no rule: `CONDITION_RULES` is empty by design (`lib/policy/condition-rules.ts:1-17`); the only condition check is the pregnancy and tuna literal (`lib/policy/constraints.ts:243-249`); condition packs stay off behind `CONDITION_PACKS_ENABLED` (`lib/policy/profiles/condition-packs.ts:73-91`). **Caveat 3: Jev is on the rules path today.** A cached Jev facet can escalate an allergen to `listed` (`lib/policy/allergens.ts:212-240`, the `flagged` test at `:231-232`), and the warm path stores that result as `source = 'jev'` (`lib/server/allergen-evidence.ts:201-207`; column at `supabase/migrations/20261118090000_allergen_evidence.sql:45-46`). Jev facets also block AND clear diet and religious preference flags (`lib/policy/constraints.ts:349-355`) and confirmed profile hard rules (`lib/policy/profiles/hard-rules.ts:52-55`). |
| Onboarding has sex, location and goals. | Sex and goals yes; location no. | Steps: Body, Activity, Goal, Dietary preferences, Foods, Your plan (`components/Onboarding/OnboardingFlow.tsx:45`). Sex is `female` or `male` (`lib/types.ts:162`). Goal is `lose_fat`, `recomp`, `maintain` or `gain_muscle` (`lib/types.ts:45`) with a weekly rate (`supabase/migrations/20261029090000_rate_goals.sql:19-21`). There is no country or region field. The only place-like data is `user_settings.time_zone` (`supabase/migrations/20261024093000_health_time_zones.sql:3`) and a free-text shopping locale (`supabase/migrations/20261127090000_recipe_catalog_shopping.sql:197`). There is no cuisine field: cuisine exists only as a coach-memory kind (`lib/coach/memory.ts:20`) and as a recipe label. |

### 2.2 Other facts that shape this design

- **Occasion history is on `main` (O2).** Affinity now takes the account's own history where it
  qualifies (`lib/meals/affinity.ts:37`, `:44-50`): at least 3 distinct days in 90
  (`lib/meals/history.ts:23-24`). `GET /api/foods/eligible?v=2` returns the meal snapshot
  (`app/api/foods/eligible/route.ts:10-21`), which the phone may use for 7 days
  (`lib/meals/snapshot.ts:30`).
- **A ticked generated meal writes no log entry.** `writeEatenSlot` copies the plate into
  `item_overrides` and marks `eaten_slots` (`lib/plan-day-client.ts:242-255`). A stored component
  carries only name, qty, unit, role and macros, with no food ref (`lib/sync/plan-days-schema.ts:6-11`).
- **A captured mixed dish stays one item.** The prompts ask for one item per distinct food
  (`lib/ai/prompts.ts:39`, `:80`), with no ingredient field (`lib/ai/schemas.ts:43-62`).
- **USDA catalog rows have no ingredient breakdown.** The import leaves `catalog_ingredients` empty
  (`docs/catalog/import.md:174-175`). The catalog holds 13,694 foods: Foundation 469, SR Legacy
  7,793, FNDDS 5,432 (`docs/catalog/receipts/2026-09-12-production-import.txt:3-15`).
- **No popularity data exists in the repo.** Neither the catalog nor `lib/food-db.json` has a
  frequency field. The only frequency signal is each user's own 90-day log count in `catalog_search`
  (`supabase/migrations/20261018090200_catalog_search_policy_categories.sql:96`, `:108-120`).
- **The bundled food list has 460 foods** with USDA SR Legacy values and household portions
  (`lib/food-db.ts:20-28`), picked by a hand-written list in `scripts/build-food-db.py:31-512`.
- **A recipe consumption stores one component.** Ingredient detail lives on the accepted selection
  (`supabase/migrations/20261128090000_recipe_plan_accept.sql:33`), joined through
  `recipe_consumed_requests.selection_id` (`supabase/migrations/20261130090000_recipe_consumed_cas.sql:8`).
- **The engine's score** is macro fit × anchor affinity × mean side pairing × date variety ×
  simplicity × vegetable preference (`lib/meals/plate.ts:179-185`). The side shortlist keeps 2
  starches, 2 fruits and 1 of each other part (`lib/meals/plate.ts:72`), and `sideCandidates`
  rescans the pool for every anchor (`lib/meals/plate.ts:98`).
- **Suggestions made one Jev call (now a budget of three logical calls, W089)** over the policy-clean set inside an 8-second budget
  (`lib/coach/suggest.ts:70`, `:143-160`). When Jev is slow or down, the fit order stands
  (`lib/coach/suggest.ts:122`). The Jev transport defaults to a 3-second deadline
  (`lib/ai/typesafe.ts:15`) and returns `null` on any failure (`lib/ai/typesafe.ts:181-183`).
- **A Jev facet cache is shared across accounts** for catalog foods (`lib/foods/facet-keys.ts:15-20`).
  Phase 17 D3 forbids account-derived affinity in it (`docs/specs/phase-17-meal-occasion.md:107-111`).
- **No machine-learning code exists.** The nearest pieces are hand-weighted search features
  (`lib/search/features.ts:26-34`) and the expenditure model, whose account seed fades as data
  arrives (`lib/expenditure.ts:9-12`).

## 3. Principles

1. **Safety runs before ranking.** Every candidate passes the account's current rules before any
   score sees it. Unknown evidence never generates a food (`lib/coach/suggest-verdict.ts:114-116`).
2. **Rules are deterministic. Jev and the model never touch them.** Allergies, conditions, Avoid,
   and diet and religious rules run in `evaluatePolicy` on stored, reviewable evidence. The
   preference module never imports the policy and returns no verdict field, the pattern
   `lib/policy/profiles/rank-foods.ts:1-6` already follows.
3. **Favored favors; it never limits.** In an open food world, a Favored food ranks higher. A meal
   still uses another safe food when that makes the better plate.
4. **Scoring stays in code.** Priors with shrinkage, personal signals that fade the prior, and capped
   similarity are precomputed or cheap in-process math. Jev is never the primary scorer.
5. **The account's own behaviour beats generic priors.** The population prior fades as the account
   makes real choices. This extends Phase 17's evidence ladder (`docs/specs/phase-17-meal-occasion.md:22-29`).
6. **Every signal can say why**, and every learned change ships only after it beats the transparent
   model on held-out data.
7. **Logging still marks and never refuses** (`docs/decisions/2026-09-14-logging-marks-never-refuses.md`).
8. **Pure on the phone, one copy of the rules.** The layout runs on the phone from a versioned,
   account-scoped snapshot. Server paths call the same pure functions.

## 4. Decisions

### D1. The candidate universe

**Decision.** "The top foods" is a curated, versioned list called the **universe**, built from the
bundled food list. It holds generic whole and minimally processed foods only, between 250 and 600
items.

| Layer | Contents | Size |
|---|---|---|
| Base | Generic staples from `lib/food-db.json`. Excluded groups: sweets (30), drinks (25), condiments (10), the branded supplement (1), and prepared "meal" rows (52) | about 340 |
| Cuisine packs | For each cuisine in the vocabulary below: its commonly eaten ingredients, tiered `core`, `common` or `occasional`. Most are base items with a tier | 30 to 60 tiered items per pack, about 10 to 20 new |

Foods missing from the bundled list are added through the curated list in `scripts/build-food-db.py`,
because the JSON is generated and never hand-edited (`AGENTS.md:91`).

The manifest is a data module, `lib/foods/universe/manifest.ts`. Each entry holds the bundled food
id, its SR Legacy code, its cuisine tiers, reviewed sensory tags (a fixed list such as `soft`,
`slimy`, `spicy_hot`, `strong_fish`, `bitter`) and a `countable` flag (false for salt, water, spices
and sweeteners). Everything else is derived, never typed by hand: parts and roles from
`lib/meals/parts.ts`; allergen evidence from stored deterministic evidence and the whole-food class
rule (`lib/policy/allergens.ts:372-382`); `policy_categories` from `lib/catalog/category-map.ts`.

**Cuisine vocabulary (12).** American; Mexican and Latin American; Italian; Mediterranean and Middle
Eastern; Indian and South Asian; Chinese; Japanese; Korean; Southeast Asian; Caribbean; African;
European (other). These are the options the dietary-profile research already reviewed for its
`cuisine` facet (`docs/research/dietary-profiles.draft.json:9122-9150`). A fixed table maps each one
onto the six pairing groups in `lib/meals/data/cuisine.ts:19-21`.

**Versioning.** `UNIVERSE_VERSION` (semver) plus a content hash; both enter the snapshot's
`inputsHash`. A change needs a PR with a review receipt in `docs/catalog/universe/<version>.md` that
names the reviewer and the diff.

**How commonness is measured.** Revision 3 uses a measured U.S. population prior (D8) from pooled
NHANES Day 1 recalls (D10). It applies only to accounts that chose the U.S., and only after the NCHS
gate; otherwise the prior is neutral. The cuisine tiers stay as a separate, stated-cuisine signal. Jev may propose tiers offline from catalog text (data class D0); a
person reviews every proposal.

**Reasons.** The catalog cannot be ranked by itself (no frequency field). Branded and Open Food Facts
rows never get whole-food clearance, so most would be unverified under any rule. 13,694 rows cannot
fit in a phone snapshot or a plate search. A curated universe lets every item carry complete,
reviewed safety evidence, so the fail-closed rule does not hide the whole open world.

### D2. How profile answers shape the plan (onboarding decided by ablation)

No ranking lift has been measured for any question. Each new ranking question must earn its place
through the ablation gate in §5. This table is the decision and its test, not an estimate.

| Input | Decision |
|---|---|
| Birth year and sex | Reuse the Body answers; add no question. Compute the age band from the birth year on the suggestion date. Map the stored `female` or `male` value (`lib/types.ts:162`) to the survey's sex coding only where the two match. A missing or unsupported value uses the national prior. The sex by age node stays off unless its held-out lift survives the mode-change check (§5). |
| Activity and goal | Reuse them for the target revision and portion sizing (`lib/profile/energy.ts:180-193`). They are not food-prior axes: the brief found no evidence that activity changes which foods people choose (brief §4). |
| Allergens, Avoid, medical food rules and chosen diet practices | Explicit, editable rule questions. Ask about the food practice, never about religion. The rule review shows kosher meat with dairy as a meal-level rule (D4). |
| Race or ethnicity | Never asked, inferred or stored for recommendations. No field or proxy enters an account snapshot. The survey field is used only in offline fairness audits (§5). Reason: a new sensitive question needs a clear benefit, and the 2021–2023 96-way split has a median of 35 people per cell (brief §1.7, [LOCAL]). |
| Country or state | No state question. `country_code` stays an optional field, and onboarding gets no required country screen. The U.S. prior applies only when the user chose the U.S.; otherwise the prior is neutral until a validated country model exists. Never derived from the time zone or geolocation. |
| Favored cuisines | Pilot one optional choice, up to 6. It stays in onboarding only if its ablation passes; otherwise it moves to Settings. |
| Food likes and taste dislikes | Pilot up to 3 optional familiar chips, or one taste-text field whose Jev-proposed chips the user confirms (D9). A conservative local check ensures any health, symptom, allergy, condition, medicine or rule text is never sent to Jev or any model and offers the rule editor instead; only plain likes and dislikes reach Jev (D9 item 3). A taste dislike stays apart from Avoid and from an occasion's "Not this". |

The provisional flow is: the existing target questions, an explicit food-rule review, then one
optional screen with cuisines, an optional country, and a few ingredient reactions or one taste text.

### D3. A food world per account

**Decision.** Add `user_settings.food_world` with the values `closed` and `open`. Only the server
writes it. `closed` is today's behaviour: the generator pool is Favored foods only. `open` widens the
pool to Favored, eaten, shopping, pantry and universe foods. The migration sets every existing
account to `closed`. New accounts become `open` only in W13. The move-over is D14.

**Reason.** One switch keeps every change reversible per account, keeps the first client's plan
unchanged until the owner decides, and lets each slice land before any account opens.

### D4. The rules and allergy boundary

**Admission order for every generated candidate** (Sol D, adopted as written):

1. Read the current account's stated rules, Avoid families, confirmed profile hard rules and food
   evidence. A failed read yields no new candidate.
2. Apply family Avoid and `evaluatePolicy` to each food and to each required recipe ingredient.
   Admit only `allowed`. Treat `blocked`, `unverified`, missing nutrition or an unmapped identity as
   unavailable for **automatic generation**. The user may still log the food and see its rule mark.
3. Build a versioned, account-scoped snapshot from the admitted set. Revoke it on a local rule change
   and on a changed server revision. Fetch the current revision before generating new suggestions
   after foreground or reconnect. An offline phone may show an existing plan, but it cannot prove
   that another device did not add an allergy while it was offline, so it makes no new suggestion.
4. Run the prior, the personal score, similarity, plate sizing and any Jev short-list check only on
   the admitted set. Recheck policy on any newly fetched or named candidate before showing it.

"Zero margin of error" is not a measurable promise about labels or cross-contact. The software
invariant is **zero policy-bypassing admissions** across every generating surface.

**Jev comes off the rules path (W2a and W2c), and the removal fails closed.**

- *Allergens (W2a).* `deriveEvidence` stops reading Jev facets (`lib/policy/allergens.ts:231-232`).
  New allergy decisions use only deterministic evidence: the label or ingredient text, legacy tags,
  stored non-Jev evidence (`source` of `label`, `ingredients` or `legacy`), the whole-food class, and
  the user's exact-product check.
- *Existing Jev-only flags never become clear.* A stored row with `level = 'listed'` and
  `source = 'jev'` is read as a **hold**: the food is `unverified` ("Not verified") for that allergen.
  Nothing automatic lifts a hold: not a complete label, not the whole-food class, not the user's
  exact-product check. Only an evidence review that replaces the row with deterministic evidence lifts
  it, and the review is logged. A deterministic `listed` (from the food's name, a tag or the
  ingredient text) still blocks: the hold only replaces a Jev-only `listed`. The writer also labels
  some name-based escalations `source = 'jev'`, because it checks only tags and ingredient text
  (`lib/server/allergen-evidence.ts:201-203`). So W2a re-derives deterministic evidence first, and
  those foods stay `blocked`.
- *Every other food stays fail-closed.* A food whose deterministic evidence cannot confirm that it is
  free of an active allergen is `unverified`. It is not admitted for generation or recommendation, and
  it is marked "Not verified" on logs. This covers foods that Jev would have flagged in future: they
  stay unverified unless deterministic evidence clears them.
- *Complete deterministic evidence decides as today.* A major allergen not listed on a complete label,
  or a whole-food class that rules the allergen out, is `allowed`.
- *Diet, religious and profile hard rules (W2c).* Jev facets also block and clear preference flags
  (`lib/policy/constraints.ts:349-355`) and profile hard rules (`lib/policy/profiles/hard-rules.ts:52-55`).
  Under the approved role they come off too, with the same fail-closed rule: a Jev-only `present`
  becomes `unverified`, and a Jev `absent` no longer clears. Ingredient tags, `policy_categories`,
  ingredient text and the whole-food class decide. Because this can hide foods that Jev cleared
  before, W2c attaches a per-account impact count before it merges.

**Other exclusions in the open world:**

| Exclusion | Rule | Reason |
|---|---|---|
| The "no evidence" gate with no allergen rule | Universe items always carry evidence, so the legacy gate (`lib/policy/constraints.ts:188-191`) never decides them. An explicit Favored mark keeps its current clearance for the account's own food. An eaten count clears nothing. | A ranking signal never becomes safety evidence. |
| Conditions | An account with a stored condition stays closed until, for each condition, the user confirms the matching pack's safety items or confirms "This condition does not limit what I eat". `POST /api/foods/world` refuses `open` with `409 condition_review` otherwise. **A condition added or edited later** (on any device, by Settings, the coach or sync) re-runs this gate before any new suggestion: the server sets the account back to `closed` and marks its rules as needing review, the existing gate that already stops generation (`lib/server/eligible-foods.ts:69-73`; the phone waits on it, `lib/foods/layout-plan.test.ts:77`). No new meal is generated, from Favored foods or any other source, until the user confirms the new condition. A pack's soft rules feed the score through `rankFoods` (`lib/policy/profiles/rank-foods.ts:24-44`). | A diagnosis activates no rule today (`lib/policy/condition-rules.ts:1-17`): the policy allows bread for an account with "celiac" (review probe). So the app cannot compute which categories a new condition affects; closing only "affected categories" is not possible without a pack. Closing the whole account and pausing generation is the only fail-closed choice. Returning to the closed world alone is not enough, because a Favored food (bread) could still be generated. |
| Banned categories | Every universe item stores non-NULL `policy_categories`; `{}` means checked and clean. | A NULL falls back to name rules (`lib/server/catalog.ts:192-197`), which is weaker evidence. |
| Avoid list | An Avoid mark on any member of a normalized name family excludes every universe, eaten, shopping and pantry food of that family, with the normalization of `set_food_membership` (`supabase/migrations/20261023090100_food_membership.sql:17-21`). Similarity never reaches an excluded food. | The user marked the family, not one row. |
| Unknown or incomplete nutrition | A universe item must have finite, non-negative macros and positive energy (W1). `usableForGeneration` (`lib/meals/pool.ts:16-23`) still guards every food at runtime. | Unknown is never read as 0. |
| Meal-level rules | A rule about a combination runs on the assembled plate. Kosher meat with dairy is the first one: no generated plate holds a food with deterministic meat evidence beside a food with deterministic dairy evidence, and a plate whose foods cannot be proved apart is not generated. Today the kosher flag checks pork and shellfish only (`lib/policy/facet-rules.ts:40-43`). W2b adds a pure plate-rule check in `lib/policy/`, and W8 calls it inside the plate search. | A food-by-food check cannot see a combination (brief §4). |
| Stated diet practices | Vegan, vegetarian, halal and kosher are stated rules, never inferred cohorts. Published EPIC-Oxford food-group ratios may later re-rank foods *inside* the allowed set, only after a U.S. holdout validates the transfer. They can never clear or create a rule. Not in Phase 18. | Brief §4: no public data links observance to food choice. |

### D5. Eaten history and choice episodes

**Decision.** Compute history on read from the source rows. Store no counter table. A pure module,
`lib/meals/taste.ts`, does the arithmetic. A server reader, `lib/server/taste-history.ts`, reads with
the user's own client and an explicit `user_id` filter, live rows only, over 180 days through
`lib/server/date-chunks.ts`. This is Phase 17 D3's tenancy rule.

**Identity.** An eaten food maps to one universe item when it can (by SR code, catalog food or exact
name), else to its normalized name family. A family match counts at half weight.

**Sources.** `log_items` of live entries (a "Log a meal" entry already stores one item per food,
`lib/log/picked-commit.ts:355-359`); eaten accepted recipes, through `selection_id` and the selection's
`ingredient_snapshot`, counting ingredients of 10 g or more; ticked generated or user-set slots in
`plan_days`; and mixed dishes, whose FNDDS recipe inputs count at half weight once W4 loads them and
are marked as estimated. From W3 on, a generated component carries an optional `foodKey`, so a tick
matches exactly. Older ticks match by name. The phone schema is not strict
(`lib/sync/plan-days-schema.ts:6-11`), so an old client drops the field and the reader falls back.

**One eating episode.** A consumed recipe, its eaten slot and any log for the same meal are one
episode, counted once (Sol W3). The provenance of every count is kept and exposed.

**Counts:**

- `H_f`: distinct eaten days in 180, each weighted `2^(-age/45 days)`.
- `Q_f`: chosen or added events: a swap pick, a Plan-sheet "Add", a manual shopping line.
- `N_{f,o}`: "Not this" or swap-away events at occasion `o`, counted only when the food was actually
  offered. "Not this" means *not for this occasion*; it is not a taste dislike.
- `M`: independent recent choice episodes, at most 4 a day, with a 90-day half-life. It drives the
  prior fade (D8).

**Exceptions (owner item 1).** History is always kept: it is the user's record. Personal evidence
counts only for foods whose current verdict is `allowed`. A food on Avoid, or blocked or unverified
under a rule, never becomes a candidate. If the rule goes, the same history counts again. Items under
10 g and items with `countable: false` add nothing.

**Reasons.** Edits and deletes are right on the next read, with no backfill. About 3,600 rows in 180
days fits the date-chunk reader. Behaviour data gets no new table.

### D6. Explicit and implicit preferences

| Layer | Stored as | Written by | Used as |
|---|---|---|---|
| Favored (explicit like) | `user_food_prefs.status = 'eats'` (value unchanged) | The user: Foods, onboarding picks, confirmed chips, coach `add_to_eats`, the star | `F_f = 1` |
| Taste dislike (explicit) | `user_settings.diet_prefs.taste.dislikes`: up to 50 universe families or sensory tags | The user only, through a confirmed chip or the food sheet | `L_f = 1` for matching foods. It lowers rank and never excludes. |
| Eaten often (implicit) | Nothing new; derived (D5) | The app | `H_f`, shown as "Eaten often" with counts and one-tap "Favor" |
| Shopping and pantry (time-boxed) | Existing rows (D7) | The user's list and pantry | `S^shop_f`, `S^pantry_f` |

**Decision.** Eaten ingredients do not become explicit Favored marks. A taste dislike is not Avoid
and not "Not this". Like the water settings, `diet_prefs.taste` must be carried by every `diet_prefs`
writer.

**Reason.** The owner asked to keep implicit and explicit apart. A one-off meal must not become a
standing favorite, and a deleted log must not leave a mark behind.

### D7. Shopping and pantry signals

- **A used line** is checked (line or purchase window) or has `origin = 'manual'`. An unchecked line
  that the planner made never counts, so the app's own plan cannot train its own rank.
- **Line time box:** from the period's `start_date` to its `end_date` plus 3 days, at most 21 days.
  Lines store no check time, so the period's dates are the box.
- **Pantry time box:** 14 days after `confirmed_at`; confirming again restarts it; deleting ends it.
  A photo draft gives no signal until the user confirms it.
- **Pantry amount** (owner decision "zero-ends-focus", 2026-10-11, W024): a row whose amount is
  explicitly 0 g is used up and gives no signal, the same as a deleted row. A row with no amount
  (unknown) still counts. The 14-day box is unchanged. The phone re-reads its focus keys after
  every pantry write (`lib/shopping-client.ts`, `lib/shopping/pantry-photo-client.ts`).
- **Shopping focus ("use my shopping list").** `user_settings.shopping_focus_until` turns focus on.
  While it is active, every generator ranks plates by the key (fits the slot, coverage, score).
  Coverage is the share of plate calories from list and pantry foods, rounded to steps of 0.25. The
  default end is the period end, or 7 days; the maximum is 31 days.
- **Gate.** Shopping and pantry exist only for accounts with recipe access
  (`lib/server/recipe-access.ts:8-25`). Elsewhere these signals are empty.

### D8. The recommendation model (`pref-2`)

This is Sol's model (design §A), with the second pass's prior, graph and pairing changes. It replaces
revision 1's `pref-1` sum, which stays only as an evaluation baseline. Closed accounts keep `pref-0`:
no taste term. **All constants are starting values to fit by respondent holdout and account replay.**

**1. Population prior (revision 3).** For food key `f` and cohort `c`, `r_{c,f}` is the
survey-weighted share of people who ate at least 10 g of `f` on a recall day (day prevalence). Count a
person once per food per day. Expand an FNDDS dish through its documented ingredients, recursively,
and mark them as estimates of a dish, not its exact recipe. The 10 g threshold is a proposed filter
for trace ingredients. Day prevalence is the ranking prior; share of energy suits portions, not
preference (brief §2.2).

**Data.** Pool the 2017–March 2020 and August 2021–August 2023 **Day 1** releases after mapping each
release's codes to stable app food keys. Use each release's own dietary weights and survey design,
divided by the number of releases pooled (brief §1.6). Keep a release-specific estimate beside the
pooled one, because the 2021–2023 Day 1 interview moved to the telephone and dropped race and income
oversampling (brief §1.2). Day 2, with its own weights, is a sensitivity check only. Two recalls from
one respondent are never two people.

**Hierarchy: national → sex by age.** Fit the national rate first, with a Jeffreys `Beta(0.5, 0.5)`
root. Shrink each sex by age estimate toward it:

```
p_{c,f} = (n*_c · r_{c,f} + m_c · p_national,f) / (n*_c + m_c)
```

- `n*_c` is the survey-adjusted effective sample size: the Kish effective size divided by the
  design effect (brief §2.4).
- `m_c` starts at 200 and is then fitted on held-out respondents.
- A cell below 30 effective respondents contributes little or no independent estimate (the NCHS
  standard for proportions, brief §1.6).
- A child falls back to the national rate when it is sparse, its field is missing, or its held-out
  lift fails.

The hierarchy has **no region or state node**: public NHANES files carry no geography, and anything
below national level needs NCHS Research Data Center access (brief §1.1). It has **no race or
ethnicity node** (D2). The model is labelled **U.S. prior**.

**When the prior is neutral.** `P_f = 0` when the ruling file is missing (the NCHS gate, D10), when the account has
not chosen the U.S. (D2), and for a food the build could not map.

Within each meal part, the prior is centred and capped, so anchors compete with anchors and sides
with sides, and a staple's raw frequency cannot overwhelm the plate template:

```
P_f = clip( logit(p_{c,f}) − median_{g in same part} logit(p_{c,g}), −1.5, 1.5 )
```

**2. Direct personal evidence.**

```
D_{f,o} = clip( 1.2·F_f − 1.6·L_f + 0.7·log(1+H_f) + 0.5·log(1+Q_f) − 0.7·log(1+N_{f,o})
                + 0.2·S^shop_f + 0.2·S^pantry_f, −2, 2 )
```

Avoid, allergies and diet rules never enter `D`; they run in policy (D4).

**3. Prior fade.** `w(M) = 2^(−M/12)`, and 0 at 60 or more episodes. Twelve effective episodes halve
the prior; 36 leave one eighth. This follows the account-seed fade pattern in the expenditure engine
(`lib/expenditure.ts:9-12`), but food choices never change TDEE.

**4. Typed substitute edges and capped similarity (revision 3).** The graph has two edge types. A
**substitute** edge spreads a preference ("tastes like": venison to bison). A **pairing** edge judges
whether two foods belong on one plate (bread and butter). Raw co-consumption is pairing evidence
only; the similarity of two foods' co-consumption *neighbourhoods* can be substitute evidence
(brief §5.2). Proposed substitute score, from licence-safe sources only (D10):

```
sub(f, g) = 0.40·tax + 0.25·nutr + 0.15·ctx + 0.15·like + 0.05·comp
```

- `tax`: FoodOn and FNDDS taxonomy similarity.
- `nutr`: FDC nutrient-profile similarity.
- `ctx`: shared context in the Ahn ingredient lists.
- `like`: published UK Biobank liking aggregates, only where their reuse terms are confirmed.
- `comp`: Ahn compound overlap, only where both foods are a fruit, herb or spice with useful
  compound data.

A missing term adds nothing, and the other terms are **not** renormalized, so a pair with thin
evidence stays weak. Each food keeps at most eight compatible neighbours in the same part. Venison to
bison rests on taxonomy and nutrients; the compound data has no game meat at all (brief §5.3,
[LOCAL]). For a food with no direct evidence:

```
G_f = clip( 0.2 · Σ_j K_fj·D_j / Σ_j K_fj, −0.10, 0.10 )
G_f = 0 when f has direct feedback, and G_f = 0 when Σ_j K_fj = 0 (no neighbour)
```

`K` is the substitute score. A food with no neighbour gets `G_f = 0`, never a division by zero. A taste dislike spreads only along a reviewed sensory edge of at least
0.7. An occasion-specific "Not this" never spreads. A Jev pair label never creates a substitute edge
and never spreads a dislike.

**As built (W7, accepted 2026-10-06, decisions.log).** "`G_f = 0` once the food has direct feedback"
is read as: the reported spread term is 0, but the neighbours' estimate is RETAINED as a floor in the
direction of the direct evidence (`personal = max(0.45·D, G)` when `D ≥ 0`, `min(0.45·D, G)` when
`D < 0`; reported as `retained`, reason `like_liked` / `like_disliked`). The literal rule cannot hold
together with W7 acceptance 3 (monotonicity): a first faint eaten day adds about 0.003 to `z`, so
dropping a 0.10 neighbour lift would lower the food. The orchestrator accepted the retained floor
over the literal text. W8 supplies no reviewed sensory edge (the W1b graph has no sensory review),
so no dislike spreads to a neighbour; a dislike lowers only the foods it names (family or tag).

**5. Pairing score (revision 3).** Proposed adjustment of the Phase 17 pair score:

```
pair = clip( B + 0.20·(co − B) + 0.15·(jev − B) + 0.05·(comp − B), 0.3, 1 )
```

- `B` is the curated Phase 17 score (`lib/meals/affinity.ts:93`) with account history: an anchor and
  side eaten together on at least 3 distinct days in 180 set `B` to at least 0.85.
- `co` is calibrated co-consumption (NHANES same-occasion recalls and the Ahn ingredient lists).
- `jev` is Jev's calibrated offline pair probability (D9 item 2).
- `comp` is Ahn compound pairing, for fruit, herbs and spices only.
- An absent feature adds zero.
- **The Jev weight is 0.15, and it stays 0 until its held-out lift passes (§5).** It is fitted on
  training folds only.
- The floor is `PAIR_FLOOR = 0.3` (`lib/meals/affinity.ts:40`). The clip keeps every scored pair at
  or above it, so no feature can push a pair out. A pair that the curated table rules out (score 0.1,
  below the floor) is excluded before the formula, and the clip never lifts it.
- The date-aware day assignment (`lib/meals/day.ts:51-141`, `planDay` at `:143`) is unchanged.

**6. Final rank.** `C_f` is the best stated-cuisine tier (core 1, common 0.6, occasional 0.3, else 0).
`R_f` is the confirmed soft-rule result from `rankFoods`. At snapshot build, compute and quantize:

```
z_{f,o} = clip( 0.20·w(M)·P_f + 0.45·D_{f,o} + G_f + 0.15·C_f + clip(0.05·R_f, −0.20, 0.20), −0.8, 0.8 )

T(plate) = exp( Σ_{f in plate} (kcal_f / kcal_plate) · z_{f,o} )

score = Phase17Fit × occasionAffinity × pairing × variety × simplicity × vegetablePreference × T
```

The first six factors and portion sizing stay as they are (`lib/meals/plate.ts:146-185`). For
open-world accounts, a plate that meets the slot's fit rule ranks ahead of one that misses it. When
none fits, the closest plate shows with its existing miss reason and no fit claim. The target
revision and the TDEE engine stay authoritative. Focus mode wraps the score in the D7 key.

**Where it lives and who calls it.** `lib/meals/preference.ts` (pure) holds `pref-2`, its constants
table `PREFERENCE_WEIGHTS` and the `z` and `T` functions. It never imports `lib/policy/*`. Callers:

| Caller | After |
|---|---|
| Daily layout (`planDay`, `rankPlates`) and the swap sheet | `T` from the snapshot's quantized `z` values |
| `compose_meal` (W9) | The pinned one-slot `rankPlates` entry, so the same score |
| `suggest_options` (W10) | `rankPlates` best plate per anchor over the pool, then the Jev short-list check (D9) |
| Recipe search, the coach and the shopping planner (`lib/recipes/candidates.ts:59-64`, `lib/shopping/planner.ts:100-126`) | The same `T` over the recipe's ingredients by grams, as `RECIPE_TASTE_POINTS × (T − 1)` with a starting value of 6, replacing the favorite-food +1 and the unused "usual" +0.25. The favorite-recipe +3 stays. |

### D9. Jev's role (approved by the owner)

This replaces every earlier "verifier" or "creative" use of Jev in this spec.

1. **Scoring stays in code.** Formulas, probabilities and the fitted models in D8 do all the ranking,
   precomputed or as cheap in-process math. Jev is never the primary scorer.
2. **Offline pair-plausibility labels are Jev's main use.** At build time a script asks Jev, for a
   fixed food pair or plate pattern and a stated meal occasion, "is X with Y a normal pairing or
   meal?". The questions carry catalog food names only (data class D0, a new registered purpose
   `pair_plausibility`). The script calibrates the raw probabilities against independently reviewed,
   human-labelled pairs, as the facet eval does (`scripts/eval/jev-facets/`); Jev never grades its
   own labels. It stores the calibrated value with the source and prompt versions, the calibration
   version and the coverage. The result is one versioned feature of the pairing graph (`jev` in D8
   part 5), beside co-consumption and compound data. Its weight stays 0 until the held-out lift passes
   (§5). A script refreshes it. It is never in the hot path and has no per-request cost.
3. **Free text becomes confirmable chips.** In onboarding (one optional taste-text field) and in the
   coach, text such as "I can't stand mushy textures" or "I grew up on Tex-Mex" becomes likes, taste
   dislikes and cuisines, shown as chips. A **conservative local check runs first**, in code, and
   decides whether the text may be sent to Jev or any model:
   - It keeps the text local when it names an allergen, a condition, a medicine or a rule ("I'm
     allergic to", "celiac", "I keep kosher").
   - It also keeps the text local when it describes a body effect or a symptom, even without naming
     a condition: a body or symptom word ("vomit", "cramps", "bloated", "nausea", "rash", "pain",
     "sick", "reflux", "headache", "diarrhea") or a cause-and-effect form ("makes me", "gives me",
     "I get … after", "doesn't agree with me", "upsets my stomach").
   - When it is unsure (an unknown word next to a food, a negation it cannot parse, more than 200
     characters), it keeps the text local.
   - Kept text is never sent to Jev or any model. The dietary field's raw text is still saved to the
     user's own account (`diet_prefs.text`), as on main. The phone offers the rule editor ("Add this as a
     food rule?") or asks for plain likes and dislikes ("Tell me foods you like or don't like").
   - The same check gates every Jev call whose input is the user's free food or taste text: the
     taste text (`profile-taste`), the dietary-preference text (`profile-prefs`, which answers the
     local route with no flags when it keeps the text) and the coach's intent pre-pass (a rule,
     symptom, or unsure taste statement is never classified; the app's own command phrases are set
     aside before the check). Any statement that restricts what the person eats or drinks, and every
     named diet or practice, is a rule. **Scope (coordinator decision, W5b round 2):** this gate
     covers the taste and preference text purposes only — `profile-taste`, `profile-prefs` and the
     coach intent pre-pass's classification. The main coach reply (the coach model), `suggest-options`
     (ranking candidates for a wish) and `coach-verify` (checking the reply) are the existing
     consented coach pipeline and are NOT gated by it; review W5b against this scope.
   - Only text that passes is sent, and it is sent as typed, with no profile or rule data. This extends the existing dietary-text chips (`app/api/profile/prefs/route.ts`,
   `lib/profile/pref-questions.ts:69-76`): a chip is suggested at a probability of 0.8 or more, and
   the user confirms each one. Jev never writes a rule, a like or a dislike by itself. A mistake by the
   local check may only keep plain text local; it must never send health text out. A confirmed
   like writes a Favored mark; a confirmed dislike writes `diet_prefs.taste`; a confirmed cuisine
   writes `cuisines`.
4. **One short-list check per suggestion run.** The formulas pick the top 5 to 8 admitted plates.
   One optional Jev call may reorder them or veto an implausible plate. Bounds:
   - It sends only generic candidate identities and meal descriptions: no profile, no rule, no
     medical note, no account identifier and no custom food name.
   - It never adds a candidate, never moves a plate that misses the slot's fit ahead of one that
     fits, and never removes a food the user named in `compose_meal`.
   - It keeps at least 3 cards. An invalid answer, a timeout or too many vetoes restores the formula
     order.
   - It uses a short, measured deadline with **no retry**. Today's transport retries once on 429 and
     529 (`lib/ai/typesafe.ts:214-216`), so this call passes a no-retry option.
   - It stays inside the suggestion budget (`lib/coach/suggest.ts:70`). When Jev is slow or down, the
     formula order stands, as today (`lib/coach/suggest.ts:122`, `:143-160`).
   - **Shadow mode first.** A veto changes no output until its precision on an independent,
     human-adjudicated holdout is at least 95 % with a 95 % confidence-interval lower bound of at
     least 90 % (§5). Until then each veto is recorded as a review reason only.
5. **Not Jev's job.**
   - Ratios and portions are formulas: `lib/meals/size.ts`, the portion bands and the templates. Jev
     may flag that a meal "looks off", but it never sets a number.
   - Creative ideas come from the LLM lane (`photoToIdeas`, `documentToPlan`, the coach). Jev only
     filters and orders them.
   - Allergies, conditions, Avoid, and religious and diet rules stay deterministic in
     `evaluatePolicy` (D4). Jev has no input to and no output on that path.
   - Jev does not decompose dishes. Mixed-dish ingredients come only from documented FNDDS inputs
     (W4).
   - Jev does not create substitute edges or spread a taste dislike.
6. **Latency.** The fast path runs on precomputed scores. The phone layout makes no Jev call. A
   suggestion run is held to the request budget of three logical Jev calls (W089); the ranking call is on the short list only.

### D10. Data build and artifacts

**Inputs** (Sol pass 2 §B and the brief §1, §5):

| Input | Use and limit | Licence |
|---|---|---|
| NHANES/WWEIA 2017–March 2020 and August 2021–August 2023 Day 1 individual-food files (`DR1IFF`), with demographics (`DEMO`) | The pooled U.S. prior, national → sex by age (D8), and the NHANES part of the `co` pairing feature (D8 part 5). Each release keeps its own weights (`WTDRD1PP`, `WTDRD1`) and a release-specific estimate. Day 2 files are a sensitivity check only. The race and Hispanic-origin field is used only in offline fairness audits; it never enters an artifact. Row-level NHANES data never ship; only aggregates do. | Free. Statistical reporting and analysis only; no attempt to identify anyone; no linkage to identifiable data. **Approved by the owner's ruling; NCHS gate below.** |
| FNDDS 2021–2023 ingredients (`FNDDSIngred`) | Map recalled food codes to ingredients and grams, recursively. A documented recipe input is an estimate of what a dish contained, not the respondent's recipe. Used for the prior and for W4's dish history. | U.S. government work; public domain [ESTIMATE, brief §1.8] |
| FoodData Central (SR Legacy, Foundation) | Join to the active catalog identity and nutrition; the `nutr` substitute term. | CC0 1.0 |
| FNDDS food-code hierarchy and FoodOn | The `tax` substitute term. | Public domain; FoodOn CC BY 4.0 with attribution |
| Ahn et al. 2011 flavor-network data | The `ctx` term (ingredient-list context) and the small `comp` term (fruit, herbs and spices only). | CC BY 4.0 with attribution |
| UK Biobank food-liking map (May-Wilson et al. 2022) | The `like` term, from published aggregates for 139 foods. Used only after the supplementary files' reuse terms are confirmed. | Paper CC BY; OSF file licence [UNVERIFIED] |
| Jev pair-plausibility labels | D9 item 2. Versioned with the model id, prompt and rubric versions and the calibration report. | Own output |
| **Held:** FlavorGraph embeddings | Kept out until its upstream recipe data rights are checked (owner question 2). | Repo Apache-2.0; upstream recipes [UNVERIFIED] |
| **Excluded:** FlavorDB, FooDB, Recipe1M+, RecipeNLG, Instacart, Kilts NielsenIQ and the Food.com set | Never in a shipped or derived artifact (brief §6.3). | Non-commercial or no rights grant |

**NCHS gate.** The owner read the NCHS data user agreement on 2026-10-05 (page dated 2024-09-17)
and approved the aggregate use. The written use decision is
`docs/decisions/2026-10-05-nhanes-aggregate-use.md`. **Every NHANES-derived artifact** is gated on
that file: the population prior (W1b) and the NHANES co-consumption part of the pairing feature
(W1c). The build refuses to emit, and the runtime refuses to load, any NHANES-derived artifact when
the ruling file is missing or the artifact manifest does not name it. If the file is ever removed or
superseded by a refusal, the prior is neutral (`P_f = 0`) and the pairing feature drops the NHANES
`co` part; the rest of the model still works. The ruling sets four **hard rules** (H1 to H4). This
spec adds H5. All five bind the build:

| # | Hard rule (source) | Named check |
|---|---|---|
| H1 | (Ruling rule 1) No respondent rows ship or persist. Raw files and respondent-level frames stay in the offline workspace; they are never committed, bundled, uploaded or written to a database. | `scripts/priors/check-artifact.ts --no-respondent-rows`: the artifact holds only cohort-keyed tables; any row keyed by a respondent fails. A `.gitignore` test proves the workspace path is ignored. |
| H2 | (Ruling rule 2) No microdata joins to users. No code path joins NHANES microdata or `SEQN` to an account, profile or app table. | `tests/foods/nhanes-no-microdata.test.ts`: scans the shipped artifacts and `app/`, `lib/`, `components/` and `supabase/` for `SEQN` and respondent-level field names (`RIAGENDR`, `RIDAGEYR`, `DR1IFDCD` and the rest); any hit fails. |
| H3 | (Ruling rule 3) Small cells are suppressed. The ruling's minimum-n floor is the D8 floor: a cell under 30 effective respondents publishes no independent estimate; it shrinks to its parent or is dropped. | `check-artifact.ts --min-effective-n 30`: every shipped cell's stored effective count is at least 30, or the cell is the parent value; the build fails otherwise. |
| H4 | (Ruling rule 4) Aggregate-only outputs. Every shipped value is a weighted rate or a shrunk estimate with its effective count; the artifact carries source release versions, checksums and the ruling's path. | `check-artifact.ts --aggregate-schema`: a strict schema allows only `{ cohort, food_key, rate, n_eff }` rows plus the manifest, and the manifest must name the ruling path. |
| H5 | (This spec, not the ruling) No sensitive axes. Race and ethnicity are used only in offline fairness audits and never enter a shipped table, snapshot or account row. | `check-artifact.ts --no-sensitive-axes` (no `RIDRETH*` value or race-keyed cohort in any artifact) and the snapshot-shape test in `tests/meals/ranking-boundary.test.ts`. |

**Build order** (offline): pin source versions, checksums and licence receipts; validate recalls and
weights; map each release's FNDDS codes to ingredient grams and then to stable universe food keys;
audit unmapped and ambiguous codes; estimate national and sex by age rates, pooled and per release;
run respondent and cluster holdouts; build the typed substitute and pairing edges; emit a manifest
with sources, licences, mapping coverage, effective counts, calibration results, coefficient version
and an artifact hash. Reject a build whose mapping coverage or calibration regresses.

**Artifacts.** The population table and the substitute graph are versioned **server-only JSON** under
`lib/foods/universe/`. A suggestion never reads a per-cohort database row. The pairing table is not
personal, so it compiles into a bundled table that `pairScore` reads identically on phone and server.
Proposed size gates, to measure after a real build: 16 sex by age cohorts plus the national root, 8
neighbours per food, and 150 KB compressed for the server-only artifacts. Refresh when a source
release or mapping changes, with a quarterly check for releases. Recompute account snapshots when an
input watermark changes.

**Regional, state and other-country sources** (brief §3; replaces the revision 2 placeholder). The
decision is to **defer** all of them. The facts behind it:

| Source | What it measures | Finest geography | Use in Phase 18 |
|---|---|---|---|
| NHANES public files | Food-level intake | National only | The base layer (D8) |
| NHANES restricted files | Food-level intake | State, county, tract | Needs an approved NCHS Research Data Center proposal, fees and disclosure review. Not planned. |
| BLS Consumer Expenditure Diary | Household food **purchases** by item code | 4 regions, 9 divisions, 4 states (CA, FL, NY, TX) | Deferred. A possible regional lift at food-category level [ESTIMATE]; purchases are not intake. |
| BRFSS fruit and vegetable module | 30-day frequency of a few food groups | State | Deferred. Fruit and vegetable groups only. |
| Circana and NielsenIQ scanner data | Retail purchases by product | State and market | Out: paid, and the academic Kilts copy forbids commercial use. |
| Google Trends API (alpha) | Search interest | State | Out: search interest is not intake. |
| Canada CCHS-Nutrition 2015 public file | Food-level 24-hour recalls, 20,487 people, 10 provinces, with "completely excludes" questions | Province | Deferred as a separate country build. Its foods are coded to the Canadian Nutrient File, so it needs its own mapping; its licence and province variable are [UNVERIFIED]. |

The brief's proposed state approach, if it is ever built, has two parts, both [ESTIMATE]: a
composition effect that re-weights the national cohort prior to a state's age and sex mix from Census
ACS, and a regional lift from the CE Diary by food category, shrunk toward 1 and clamped to
[0.67, 1.5]. Neither is in Phase 18. Until a validated country or state model passes the §5 lift test,
the only prior is the U.S. prior, and only for accounts that chose the U.S. A user's own logs teach
regional foods faster than any public source.

### D11. Snapshot v3, the phone pool and latency

`GET /api/foods/eligible?v=3` extends O2's v2 contract (`lib/meals/snapshot.ts:27-30`). v1 and v2
stay unchanged.

```
{ schemaVersion: 3, rankingVersion, universeVersion, prefVersion, priorVersion, graphVersion,
  accountId, rulesVersion, evidenceVersion, computedAt, inputsHash, world: "closed" | "open", focusUntil,
  admittedUniverseIds: string[],   // the only universe items the phone may generate from
  admittedRefIds: string[],        // the only account and catalog refs the phone may generate from
  foods: { [foodId]: { userRefId, catalogRefId, universeId, source, parts, occasion, family,
                       z: { [occasion]: quantized }, reasons: string[],
                       perUnit?, unit? } },
  excluded: ExcludedFoodRef[] }
```

- **The admitted set is explicit and positive.** `admittedUniverseIds` and `admittedRefIds` list
  every food the server admitted (D4). On the phone, a food whose universe id or ref is not in those
  sets is **unavailable**, even when its data is in the bundle or in the local store. Omission always
  means unavailable; there is no default-allow. `foods` carries the ranking data (`z`, parts,
  occasion, reasons) for admitted foods only. `perUnit` and `unit` appear only for an admitted eaten
  food that has no universe item and no local row. Excluded foods appear only in `excluded`, as ids
  with reasons, never with nutrition.
- A universe item's nutrition and portions come from the bundled food list and the manifest, so the
  snapshot sends ids and `z` values, not the cohort table. The bundle is a nutrition source only,
  never an admission source.
- **Freshness token: two admission-input versions.** The token is the pair `{ rulesVersion,
  evidenceVersion }` (wire names unchanged). They are versions of admission's INPUTS, not of the
  rules alone (W2b re-plan, 2026-10-06, after two review rounds found column-by-column triggers
  missing inputs that clear or rename a food): every insert, update or delete of a table that
  admission reads moves a counter. One inventory lists those tables
  (`lib/foods/world/admission-inputs.ts`), and a test fails until each has insert, update and delete
  clock triggers, so every column counts by construction; reading a new table means adding it there.
  - `rulesVersion` is one monotonic counter per account in `account_rules_clock (user_id primary
    key, rules_rev bigint)`. A row trigger bumps it, in the same transaction, on any write to the
    account's admission inputs: `constraint_profiles`, `user_food_prefs`, `food_membership_revisions`,
    `user_settings`, `user_dietary_profiles`, `food_world_condition_confirmations`,
    `user_allergen_checks` and `user_foods`. An update that moves a row to another account bumps both
    owners. This over-invalidates on purpose: an Eats-only, water or meal-count edit moves it too and
    costs one refetch. A counter replaces revision 4's hash of maximum revisions, which missed an
    older transaction committing after a newer one (review finding 1). Each transaction bumps it at
    most once, with `rules_rev = rules_rev + 1` under the row lock, so two concurrent writes move it
    twice and one transaction writing many rows or tables moves it once.
  - `evidenceVersion` is one global counter in an `evidence_clock (id, evidence_rev bigint)` row.
    Statement-level triggers bump it once per nonempty insert, update or delete statement (at most
    once per transaction) on the shared admission inputs: `food_allergen_evidence`,
    `catalog_ingredients`, `catalog_food_revisions`, `catalog_food_nutrients`, `catalog_foods`,
    `catalog_portions`, `food_refs` and `food_facets`. An upsert that rewrites unchanged rows moves
    it too. The W2a review script and the universe annotate script write through those tables, so
    they bump it. The single row serializes concurrent writers of these tables until commit; the
    W2b rehearsal measures it, and W8 must not rely on held admissions if live contention is
    material.
  - Today's `rulesRevision` covers only the constraint profile (`lib/server/eligible-foods.ts:82`);
    it stays in v1 and v2 only.
- **Freshness.** Before any new suggestion (layout fill, swap, coach card, recipe), the phone asks
  `GET /api/foods/rules-version` (one small read of both counters) after foreground, after
  reconnect, and at least once per suggestion run. A different `rulesVersion` or `evidenceVersion`
  discards the snapshot and forces a fresh admission read (v3 refetch) before generating. O2's 7-day limit (`lib/meals/snapshot.ts:30`) still applies on top. The local rules
  epoch (`lib/foods/rules-epoch.ts`) still revokes the snapshot at once after a rule write on this
  device. Offline, the phone shows the last plan and makes no new suggestion (owner question 6).
  Server paths (coach, recipes, compose) always run a fresh admission read.
- **Size:** at most 250 KB of uncompressed JSON for any realistic account (the bounded universe
  pool plus a normal Favored list); never enforced by dropping a `foods` entry (see §W8 acceptance
  5's stated exception for why, and for the rare, logged over-budget case).
- **No sensitive cohort data.** The server computes `z` from the cohort prior and sends only the
  quantized values. No cohort key, sex, age band, race or ethnicity field, or proxy for one, enters
  the snapshot.
- **Search bound:** 24 anchors per occasion plus the current side shortlist (2 starches, 2 fruits,
  1 of each other part). Six slots give `6 × 24 × 72 = 10,368` ordinary combinations, under the
  20,000 `sizePlate` gate with room for the widened fallback. Every admitted food stays in the
  snapshot; the search shortlist rotates by date. A user-named or pinned food enters the search
  directly. `sideCandidates` rescans the pool per anchor (`lib/meals/plate.ts:98`), so the benchmark
  times the full search, not only scored plates.
- **Proposed latency targets (not measured):** 20 ms p95 for phone scoring; 500 ms p95 for a
  refreshed eligible snapshot; no regression in the T0 journeys, which are 2 s p95 warm search to log
  and 3 s to the coach's first text (`docs/plans/2026-09-17-t0-speed-foundations.md:70-81`). The
  client deadlines (`lib/fetch-with-deadline.ts:25-33`) are ceilings, not measurements. `pnpm timings`
  and phone benchmarks run before these targets are accepted.

### D12. `compose_meal` rebuilt (O4b, folded into W9)

The O4 re-plan found a design fault: the greedy composer duplicates the engine's rules, so each
repair opened another route.

- Add one pinned, one-slot entry to `lib/meals/plate.ts`: `rankPinnedPlates(input, pinned)`. It
  enumerates the pinned foods' part assignments inside the plate search, fills missing parts
  (the anchor included) from the admitted pool (Favored rows first), and applies `partsOf`, the
  template, coherence and sizing before ranking. It never filters ordinary `rankPlates` results
  afterwards, because the side shortlist may never contain a pinned food. A pinned food bypasses
  the shortlist, never policy or nutrition checks.
  **Stated exception (W9 Sol re-plan, round 3, two failed reviews on the first pairing design):**
  a pinned food's real pairing score still weighs the plate's rank, but `PAIR_FLOOR` never rejects
  a pinned assignment the way it rejects an ordinary, pool-searched side — a plate the user named
  explicitly ("yogurt with carrots") is refused only for a template or coherence violation
  (`template.never`, `unmetRequirements`, `coherentWhole`, the meal-level plate rule, or a
  `sizePlate` failure), never for scoring low on a soft pairing heuristic. The anchorless snack
  template keeps its own small-snack gate (`occasion === "snack"` and the target at or under
  `SMALL_SNACK_KCAL`) even for a pinned assignment; an unscoped wish naming only an explicit
  fruit-and-fat pair at a snack-sized target infers that occasion before ranking, but a stated
  phrase, slot or clock is never overridden.
- A named food resolves to the user's marked row first, then to the pool, then to the catalog. The
  existing marks and the "swap a blocked food" rule still apply.
- **Incomplete named draft.** When no coherent plate holds the named foods, the card returns
  `incomplete: { reason }`, keeps every named food, sets `fitsTarget` to false, shows no fit note and
  adds no food. Unknown nutrition is never shown as a number.
- The card's four-macro `fitsTarget` check (`lib/coach/compose.ts:327`) still runs after a plate is
  chosen. The occasion and wish come from O4a's shared phrase parser, applied before the four-term cap
  (`lib/coach/compose.ts:148`).
- The O4-branch helpers `lib/coach/compose-required.ts` and `lib/coach/compose-occasion.ts` never
  merge. `lib/coach/compose-complement.ts`, `lib/coach/compose-template.ts` and
  `lib/coach/fit-portions.ts` stay for suggestion callers until W10.

### D13. Renames and wire stability

| Surface | Today | After | Lane |
|---|---|---|---|
| Foods first tab label | "Eats", or "Favorites" for pilot accounts (`components/FoodsTabs.tsx:31`, `:85`) | "Favored" for every account | UI |
| The food star (`favorites_foods`) | A bookmark that no generator reads | The Favored toggle on the same row. A one-time script turns each live star into a Favored mark unless the family is on Avoid. The table stays for history. | Backend script; UI |
| Coach copy for `add_to_eats` and `remove_from_eats` | "Eats" wording | "Favored" wording; removing says "No longer favored", because the food can still appear | UI copy, coach golden files |
| Shortage copy | Every account | Closed accounts only, reading "Favored" | Shared lib copy |
| `status = 'eats'`, sync ops, the `add_to_eats` and `remove_from_eats` kinds, `/api/foods/eligible`, MCP tools | Wire names | **Unchanged.** New fields and routes use "favored". | Backend |
| "Use my shopping list" | None | Jev intent `use_shopping_list` and action `set_shopping_focus` with Undo, gated like `add_to_shopping_list` (`lib/coach/actions/add-to-shopping-list.ts:1-11`) | Backend, coach; UI toggle |
| Free-text preferences in the coach | None | Action `confirm_taste_chips`: a chip card from the D9 item 3 classifier; each confirmed chip writes through the Settings path, with Undo | Backend, coach; UI card |

**Reason.** The value `eats` lives in rows, sync ops, saved coach `tool_calls`, MCP clients,
installed phones and the pinned golden files (`tests/coach/action-golden/`). The user sees copy only.

### D14. Moving existing accounts over

- **Existing accounts** stay `closed` after W2b. From W13, and only after the safety and plausibility
  gates pass, they see a dismissible invitation that says Favored changes rank, not permission, and
  that rules still apply. An account that opts in keeps its Eats marks as Favored marks. Accepting calls
  `POST /api/foods/world`, which applies the condition gate. Settings can switch back.
- **New accounts** become `open` at onboarding completion from W13. The open-world Foods step offers
  optional picks. No starter is marked Favored by default, and the Today auto-seed
  (`lib/foods/today-starter.ts:45`) does not run.
- **The first client's account** stays `closed` with no invitation until the owner decides (question
  5). It is held through `OPEN_WORLD_HOLD_USER_IDS`, the allowlist pattern of
  `RECIPE_PLANNING_USER_IDS`, so no personal identifier enters the code
  (`tests/tenancy/no-personal-defaults.test.ts`). It keeps `pref-0` until then.

### D15. The taste profile, in phases

| Phase | Model | Ships when |
|---|---|---|
| T1 (W7) | `pref-2` (D8): transparent prior, direct evidence, fade and capped similarity. Every food carries its reasons. | It beats `pref-1` and Phase 17 on the §5 replay, with unchanged exclusions |
| T2 (W14) | Per-account learned weights over the T1 features, trained on the account's own offered slates and choices (W6), held close to `pref-2` by L2 regularisation. Pure TypeScript; no new dependency or vendor. | Only after the §5 T2 gate |
| T3 | Cross-user learning | **Not planned** without an owner decision (question 7) |

**Privacy limits.** The app never asks, infers or stores race or ethnicity for recommendations; the
survey field stays inside the offline build and its fairness audit. Taste data is account data
(class D1). It is read under RLS and never enters
`food_facets`, a shared cache, `coach_intent_events`, `client_timings` or a model prompt
(`docs/ai-data-handling.md:128-171`, `docs/readiness/2026-09-19/12-health-context.md`, Phase 17 D3).
Jev's offline labels and short-list check send catalog food names and plate shapes only, never the
account's history. If T3 is ever approved it must use universe ids only, count a pair only across at
least 20 distinct accounts, exclude every health field, store aggregates without user ids, be
opt-in, and pass a new health-context readiness review.

## 5. Evaluation and release gates

Every gate is a **starting gate**: a proposed number, not an observed result. A later PR may tighten a
gate with a replay report; loosening one needs the owner.

**Shared metrics.**
- *Macro fit* is the engine's own `macroFit` score (`lib/meals/size.ts:119-121`, 0 to 1), averaged
  over every generated plate in the replay, shown in percentage points. *Fit rate* is the share of
  plates that pass `fitsTarget` (`lib/meals/size.ts:152-155`). The baseline is the same replay under
  Phase 17 (`pref-0`).
- *ECE* is the expected calibration error over 10 equal-width probability bins.

| Area | Method | Gate (starting value) | Why this number |
|---|---|---|---|
| Population prior | Hold out respondents and survey clusters. Compare pooled and release-specific, national and sex by age, and the neutral baseline. Report weighted hit@3, hit@10, NDCG@5, Brier score, ECE by frequency decile, effective counts and mapping coverage. Day 2 is a sensitivity check. | A node is enabled only when its weighted NDCG@5 gain over its parent has a 95 % cluster-bootstrap lower bound above 0. Sex by age is disabled if the gain's sign differs between 2017–2020 and 2021–2023. A build fails if mapping coverage (share of recalled grams mapped to universe keys) drops by more than 1 point, or if Brier score or ECE worsens by more than 0.005, against the previous build. | A lower bound above 0 is the least claim that a node helps. 1 point and 0.005 catch real regressions without failing on bootstrap noise at NHANES sample sizes. |
| Fairness audit (offline only) | Score the model on survey respondents grouped by the NHANES race and Hispanic-origin field (6 groups). The field never leaves the offline build. | For a node to ship, no group's weighted NDCG@5 may fall below the national-only model's for that group by more than 1 point, and the largest gap between any two groups may not grow by more than 2 points against the national-only model. A failing node is disabled; the fix is never a race node. | The national model is the fair reference. Per-group cells are small (median 35 per fine cell, brief §1.7), so 1 and 2 points sit above bootstrap noise at the group level and still catch a node that helps one group at another's cost. |
| Personal model | Chronological replay with snapshots built only from earlier information. Report chosen-anchor hit@3, NDCG@5, accepted meals, swaps and "Not this" rates. Compare Phase 17, `pref-1`, prior-only, direct-only and `pref-2`. | `pref-2` beats both `pref-1` and Phase 17 on hit@3 with a 95 % day-bootstrap lower bound above 0; exclusion sets are identical; mean macro fit drops by at most 1 point and fit rate by at most 2 points against Phase 17. | Taste must not cost nutrition. 1 point of `macroFit` is under one portion step on a typical plate; 2 points of fit rate is about one missed slot in 50. |
| **Jev pair labels** (graph) | Freeze the pool and other weights. Compare with and without the Jev pair feature on a blinded human holdout of at least 400 labelled pairs and on the replay. Fit the 0.15 weight on training folds only. Jev never grades its own labels. | Calibrated labels must reach Brier ≤ 0.18 and ECE ≤ 0.05 on the holdout, and beat the uncalibrated raw Jev probabilities by at least 0.01 Brier. The weight leaves 0 only when NDCG@5 gains with a 95 % interval above 0, and the implausible-plate rate does not rise. | 0.25 is the Brier score of a constant 0.5 guess, so 0.18 demands real signal. ECE 0.05 keeps a stated 0.8 within 0.75 to 0.85 on average. 400 pairs give a Brier standard error near 0.01. |
| **Jev short-list veto** | Veto precision = human-adjudicated implausible plates vetoed ÷ all plates vetoed, on an independent holdout. Report false vetoes, reorder lift, timeouts and latency. | Live vetoes only at ≥ 95 % observed precision with a 95 % interval lower bound ≥ 90 % (at least 60 vetoes observed), a timeout rate ≤ 5 %, and p95 added latency ≤ 1.5 s. Until then, shadow mode. | 60 vetoes is about the smallest count where 95 % observed precision can give a 90 % lower bound. 1.5 s keeps the run inside its 8-second budget. |
| Onboarding questions | Hide one answer at a time. Respondent holdout for survey fields; opt-in pilot for cuisine and taste answers. | At least 1 point NDCG@5 lift with a 95 % interval above 0, completion rate down by at most 2 points, and median completion time up by at most 15 s, against the flow without the question. | A question that costs more than 2 points of completion loses more users than its ranking gain is worth. 15 s is about one extra screen. |
| Safety and nutrition | The property suite (W2a, W2b) plus online tracking: allergy reports, rule-mark corrections, p95 latency, snapshot failures, repetition and first-week acceptance. | Identical exclusion sets; zero generated blocked or unverified foods; no change to target revisions or expenditure inputs; mean macro fit down by at most 1 point and fit rate by at most 2 points against Phase 17; snapshot build p95 ≤ 500 ms; phone scoring p95 ≤ 20 ms; an audited explanation for every unfilled high-protein day. A stop switch on `food_world`. | Safety numbers are zero by design. The latency numbers are the D11 proposed targets, now binding. |
| T2 | Time-forward holdout per account (W14 defines every number). | At least 30 decisions from at least 20 distinct slates of at least 5 anchors each, anchor diversity of at least 10, at least 14 days, and a hit@3 gain of at least 5 points with a day-bootstrap 95 % lower bound above 0. | See W14. |

## 6. Data model and migrations

Each migration is applied to production before the code that reads it merges.

| # | Migration | Slice | Change |
|---|---|---|---|
| 1a | `food_world_objects` + the clock trigger files | W2b | `account_rules_clock (user_id pk, rules_rev bigint not null default 0)` and `evidence_clock (id smallint pk check (id = 1), evidence_rev bigint not null default 0)`, with insert, update and delete triggers on every table of the admission-input inventory (D11). Owner-only read RLS on the account clock; read-only to `authenticated` on the evidence clock; only triggers write. Shipped live-safe as separate files `20261213090000` to `20261213091200`: columns with constant defaults and NOT VALID checks, then validate and SET NOT NULL, then tables and functions, then triggers one busy table per file, each with `lock_timeout 3s` and `statement_timeout 30s`. |
| 1 | `food_world` | W2b | `user_settings.food_world text not null default 'closed' check (food_world in ('closed','open'))`. Existing rows become `closed`. Server-written only. W13 changes the default to `open`. |
| 2 | `allergen_evidence_review` | W2a | `food_allergen_evidence` gains `reviewed_at timestamptz` and `reviewed_by text`. A review that replaces a `source = 'jev'` row records both. No row is deleted or rewritten by the migration. |
| 3 | `catalog_food_inputs` | W4 | Shared catalog table `(food_revision_id fk on delete cascade, seq, input_catalog_food_id fk, grams > 0, source in ('fndds'), estimated boolean, primary key (food_revision_id, seq))`. Written by the import worker only. There is no `jev` source: Jev does not decompose dishes. |
| 4 | `profile_cuisines_country` | W5 | `user_settings.cuisines text[] not null default '{}'` (12-value vocabulary, at most 6, no duplicates) and optional `user_settings.country_code text` (`^[A-Z]{2}$`). No state, region, race or ethnicity column. |
| 5 | `food_signal_events` | W6 | `(id, user_id, at, local_date, surface, kind, occasion, chosen_key, offered_keys text[] ≤ 8, ranking_version)`. `kind` is `picked`, `swapped_away`, `not_this` or `added`. Owner-only RLS. Purged after 180 days. |
| 6 | `shopping_focus` | W11 | `user_settings.shopping_focus_until timestamptz`. |
| 7 | `pantry_source` | W12 | `shopping_pantry.source text not null default 'manual' check (source in ('manual','line','photo'))`. |
| 8 | `taste_models` | W14 | `(user_id, version, weights jsonb, trained_at, eval jsonb)`. Owner-only RLS. Never shared. |

**No new columns** in `user_food_prefs`, `favorites_foods`, `log_entries`, `log_items`, `plan_days`
or the recipe tables. `diet_prefs` gains the `taste` key (W5), and `item_overrides` components gain
an optional `foodKey` (W3), both as JSON. Confirmed taste feedback is durable in `diet_prefs.taste`,
apart from the 180-day signal events. The prior, graphs and pair labels are versioned files (D10), not
tables.

## 7. Contracts, and backend work kept apart from UI work

### 7.1 Backend contracts

| Contract | Slice | Shape |
|---|---|---|
| `POST /api/foods/world` | W2b | `{ world: 'open' \| 'closed', confirmations?: { condition, choice: 'pack' \| 'no_limit' }[] }` returns `200 { world }`, `409 condition_review { conditions }` or `423 held`. |
| `GET /api/foods/taste` | W3 | Up to 50 identities: `{ key, name, days180, lastOn, favored, favorable, provenance }`, admitted foods only. `favorable` (additive, version stays `taste-1`) comes from the shared Favor plan (below): true when a Favor would succeed under this read, that is the key's own family is not avoided and at least one family of the item's refs is `ok` or already `eats`. It may be true while `favored` is true (the UI hides the button on `favored`). An item with no ref of its own, a family with any Avoid (including a mark the session client cannot read) or any non-`allowed` member makes it false. GET describes its read only; POST re-checks in one transaction. |
| `POST /api/foods/favor` | W3 (D6) | Body `{ key }` only. The key must be one of the caller's own current `GET /api/foods/taste` items for the same window (`?date=`, recomputed), with a ref of its own. Plan (shared with `favorable`): the item's refs (`favorKeyRefs`); each ref's name family and that family's FULL write set (`favor_family_sets`: the exact refs `set_food_membership` would write); every member judged with `tasteJudge`; family marks read owner-scoped (service role, `user_id` = session user). A family is `avoid` (any member on Avoid, the name avoided, or an Avoid mark), `blocked` (any member not `allowed`), `eats` (already marked) or `ok`. The rules and evidence versions are captured before the taste and policy reads; the `ok`/`eats` families go to `favor_food_families` in one transaction (migration `20261215090000`): sorted family advisory locks, then the rules-clock row `FOR UPDATE` and `evidence_clock` `FOR SHARE`, compared with the captured versions; then every family is preflighted (the same ref set, no Avoid on the key family or any member, every member in the judged allowed ids) before the captured ids are written, all or nothing, with `favor_rev = rev` so a ref minted later does not inherit the mark (`get_or_create_food_ref`). `set_food_membership` is unchanged. Answers: `200 { favored: true, refs, skippedAvoid, rulesRevision }` (`refs`: the item's refs in favored families; `rulesRevision` as in the taste answer, from the judgement used); `400 bad_request` (not JSON, or a field other than `key`); `401`; `404 unknown_key` (malformed, not in the taste answer, or no ref of its own); `409 rule_review_required`; `409 rules_changed { rulesVersion }` (versions, a family's write set or a member's verdict moved before the write; nothing written); `413 too_large` (over 4 KB); `422 nothing_to_favor` (no family can hold `eats`, or an Avoid landed; nothing written); `429 rate_limited` (120/min per instance before auth, 30/min per account, the repo's in-memory limiter as on every account route); `503` (`admission_unavailable`, `rules_version_unavailable` or a failed RPC). Always no-store. |
| `POST /api/profile/prefs` (extended) | W5b | Takes one optional taste text (`{ taste }`). A local safety-language check runs first: an allergy, condition, medicine or rule statement, a symptom, or unsure text returns `{ route: "local", reason: "rules" \| "symptom" \| "unsure", offer: "rule_editor" \| "plain_prefs" }` and makes no Jev call (as built: acceptance 2's `route: "local"`, with the rule case as `reason: "rules"`). Otherwise it returns `{ route: "send", jev, likes, dislikes, cuisines }`, each chip `{ key, label, p }` with p ≥ 0.8. Nothing is written. |
| `GET /api/foods/eligible?v=3` | W8 | D11, with `rulesVersion`, `admittedUniverseIds` and `admittedRefIds`. |
| `GET /api/foods/rules-version` | W2b | `{ rulesVersion, evidenceVersion }`, the two counters (D11). No-store. |
| `POST /api/foods/signals` | W6 | Up to 20 events with their offered slate. Answers 202 whatever the insert does. |
| `POST /api/profile/taste/confirm` | W5b-2 | Body `{ actionId: uuid, source: "settings" \| "onboarding" \| "coach", dislikes: TasteDislike[] (canonical, ≤ 50), cuisines: CuisineKey[] (≤ 6), coach?: { messageId, proposalId } }` (`coach` exactly with `source: "coach"`; at least one chip; no repeats). `200 { status: "applied" \| "existing", actionId, added, present, capped, undoneAt, settings }` (`added`/`present`/`capped`: `{ dislikes, cuisines }`; `settings`: the `user_settings` row after the call); `400 bad_request`; `401`; `404 not_enabled \| unknown_proposal`; `409 action_conflict \| settings_not_synced \| settings_unreadable \| account_mismatch`; `413`; `422 chip_not_proposed`; `429`; `502 taste_confirm_failed` (retry with the same id); `503`. No-store; dark until `TASTE_CHIPS_ENABLED=1`. |
| `POST /api/profile/taste/undo` | W5b-2 | Body `{ actionId }`. `200 { status: "undone" \| "already_undone", actionId, removed, gone, undoneAt, settings }`; `404 not_enabled \| unknown_action`; `409 settings_unreadable`; otherwise as confirm. A coach card's record also undoes through `POST /api/coach/undo/{id}` (`record_mode: "taste_v1"`, card `{ type: "taste", added, complete }`). |
| `GET /api/profile/taste/enabled` | W5b-3 | `200 { enabled: boolean }`, the `TASTE_CHIPS_ENABLED` switch the taste routes read; `401` without a session. Side-effect free (no write, no model call, no limiter, as `GET /api/onboarding/profile-pilot`); private, no-store. Phone: `readTasteChipsEnabled()` → `"enabled" \| "disabled" \| "unknown"` (unknown for any failure); `requestTasteChips(text)` → `{ ok: true, suggestion } \| { ok: false, reason: "disabled" }` (404 `not_enabled` only) `\| { ok: false, reason: "failed", status? }`. |
| Coach `set_shopping_focus`, `confirm_taste_chips` | W11, W5b-2 | Each with Undo. `confirm_taste_chips` is the coach card's confirm (`tool_calls.tasteChips` → `POST /api/profile/taste/confirm` with `source: "coach"`), not a model-emitted action. |
| `compose_meal` card | W9 | Adds `incomplete?: { reason }`; then `fitsTarget: false` and `fitNote: null`. |
| `POST /api/shopping/pantry/photo` | W12 | Reuses `photoToIdeas` (`lib/ai/call-registry.ts:74-75`): no new purpose, model or vendor. Keeps only `kind: "ingredients"` names, grounds them, and returns a draft with rule marks. `PUT /api/shopping/pantry` with `source: 'photo'` confirms. |

### 7.2 UI-lane hand-offs

| Slice | UI work |
|---|---|
| W2a | The "Not verified" mark copy for a held allergen, with "Evidence under review". |
| W3 | The "Eaten often" section on the Favored tab, with one-tap "Favor". |
| W5, W5b | The optional screen (cuisines, optional country, up to 3 taste chips or one taste text), the Settings fields, the confirmable chips in onboarding, Settings and the coach card, and the hand-off to the rule editor when the text is a rule. No state or race question. |
| W6 | Signal calls from the swap sheet, the Plan sheet ("Not this", "Add") and suggestion cards, each with its offered slate. |
| W8 | Reason chips on generated meals ("You eat this often", "On your list"). |
| W11 | The Shopping "Use my list" toggle and its end date. |
| W12 | "Photo of my fridge" and its confirm sheet. |
| W13 | Copy from Eats to Favored, the star as the Favored toggle, the invitation and the Settings switch. |

## 8. Safety tests

Keep and extend `lib/policy/constraints.test.ts`, `tests/coach/suggest-policy-precedence.test.ts` and
`lib/server/eligible-foods.test.ts`. Add `tests/policy/facet-escalation-removal.test.ts` (W2a),
`tests/foods/universe-data.test.ts` (W1), `tests/meals/open-world-safety.test.ts` (W2b) and
`tests/meals/ranking-boundary.test.ts` (W7). The property suite covers rule-change races, stale
offline snapshots, unmapped foods, ingredient mixtures, meal-level rules (kosher meat with dairy),
graph neighbours of excluded foods, and arbitrary prior and Jev outputs. The pass condition is zero admitted non-allowed foods on every
generating surface.

## 9. Changes to AGENTS.md "Rules that tests guard"

Each change lands with the slice that changes the behaviour.

| Rule today (`AGENTS.md:193-201`) | After Phase 18 | Tests |
|---|---|---|
| Starter and suggested foods are filtered by the account's explicit dietary rules. Ambiguous historical rules need review. No account inherits the original client's preferences. | Kept, and widened: every generated candidate passes the account's current rules with complete deterministic evidence. Unknown evidence never generates. The universe marks nothing Favored by default. | Keep `tests/tenancy/no-personal-defaults.test.ts`. Add `tests/foods/universe-data.test.ts` and `tests/meals/open-world-safety.test.ts`. |
| New account layouts generate Meal 1 to Meal N from eligible Eats and the account's target. | From the account's admitted candidates: Favored foods in a closed food world; Favored, eaten, shopping, pantry and universe foods in an open one. | Replace `lib/resolve.test.ts:53` with a closed and open pair. Add `tests/meals/favored-never-limits.test.ts`. |
| A food on Avoid never appears in any date's plan. | Unchanged in words. An Avoid mark on a family excludes every universe, eaten, shopping and pantry food of that family, and similarity never reaches it. | Keep `lib/foods/layout-plan.test.ts:70`. Add a 365-date universe sweep and a compose fill-in case. |
| A calorie change never moves the protein portion. | Unchanged. | `lib/scaling.test.ts:9-19`. |
| Any date renders a complete day. | Unchanged. An open account with no Favored foods now gets one. | A 30-date open-account case. |
| (new) | **Jev is never on the rules path.** Allergy, condition, Avoid, diet and religious decisions read deterministic evidence only. A Jev-only allergen flag stays `unverified` and never becomes `allowed`. | `tests/policy/facet-escalation-removal.test.ts`; an import-graph check that `lib/policy/*` reads no Jev facet for a rule decision. |
| (new) | **Ranking never changes a safety verdict.** | `tests/meals/ranking-boundary.test.ts`. |
| (new) | **No race or ethnicity input.** No recommendation input, snapshot or account row holds race, ethnicity or a proxy for it. | A schema and snapshot-shape test in `tests/meals/ranking-boundary.test.ts`. |
| (new) | **New suggestions need the current rule revision.** | Rule-change race cases in `tests/meals/open-world-safety.test.ts`. |
| (new) | **Favored favors and never limits** in an open food world. | `tests/meals/favored-never-limits.test.ts`. |
| (new) | **A named meal stays named.** | `tests/coach/compose-pinned.test.ts`. |

Related lines: `AGENTS.md:86` ("Neutral foods … appear in neither list nor the rotation") holds only
for the closed world. `AGENTS.md:204` notes that `eats` displays as Favored. `docs/features.md`
F-003, F-007, F-021 and F-078 change when W8 and W13 land.

## 10. Slices (the /goal contract)

The order puts safety and data first. Each slice lands on its own, behind `food_world` or with no
behaviour change, and gets an independent review before it opens. Sol's changes to W1–W14 (both
passes, §G) are folded into the slices below; the new work is split into W1b, W1c, W2a, W2c, W5b and
W15 so that each slice stays landable.

| Order | Slice | Lane | Depends on |
|---|---|---|---|
| 1 | W2a: Jev off the allergy path, fail-closed | Backend (policy) | none |
| 2 | W1: Universe v1 | Data, backend | none |
| 3 | W2b: Food-world switch and the open-world gate | Backend | W1 |
| 4 | W2c: Jev off diet, religious and profile rules | Backend (policy) | W2a |
| 5 | W1b: Population prior and substitute graph build (NHANES table gated by the NCHS decision) | Data (offline) | W1 |
| 6 | W1c: Offline Jev pair labels and the pairing table | Data (offline) | W1 |
| 7 | W3: Eaten history and choice episodes | Backend | none |
| 8 | W4: FNDDS inputs for mixed dishes | Data, backend | W1b |
| 9 | W5: Cuisines, optional country and taste storage | Backend | W1 |
| 10 | W5b: Free-text preference chips (suggestions and safety gates; writes nothing) | Backend, coach | W5 |
| 10b | W5b-2: Confirmed taste chips, written on the server (confirm and Undo RPCs) | Backend | W5b |
| 11 | W6: Signal events with offered slates | Backend | W3 |
| 12 | W7: `pref-2`, pure | Shared lib | W1b, W3, W5 |
| 13 | W8: Snapshot v3, freshness, open layout and swaps | Backend, phone lib | W2b, W7, W1c |
| 14 | W9: `compose_meal` on the pinned entry (O4b) | Backend | W8, O4a |
| 15 | W10: Suggestions and recipes, and the Jev short-list check | Backend | W8, W1c |
| 16 | W11: Shopping signals and focus mode | Backend, coach | W8, W10 |
| 17 | W12: Pantry from a photo | Backend | W11 |
| 18 | W13: Favored rename, star merge, account move-over | Backend; UI lane | W8, W9, W10 |
| 19 | W15: Onboarding question ablation | Evaluation | W5b, W8 |
| 20 | W14: Taste T2 behind the gate | Backend | W6, plus 60 days of events |

### W2a. Jev off the allergy path, fail-closed

Builds: `deriveEvidence` without facets (`lib/policy/allergens.ts:212-240`); the hold for stored
`source = 'jev'` rows; migration 2; an evidence-review script that replaces a Jev row only with
deterministic evidence and records the reviewer. No other behaviour change.

Acceptance:
1. `tests/policy/facet-escalation-removal.test.ts` passes:
   - Fixture A: a food whose only evidence for an active allergen is a Jev facet (no tag, no
     ingredient text naming it, no complete label). It is not admitted before the change (`blocked`)
     and not admitted after it (`unverified`). It is never `allowed`.
   - Fixture A2: the same food with a stored `level = 'listed', source = 'jev'` row and a complete
     label that does not list the allergen. It stays `unverified`. Neither the whole-food class nor the
     user's exact-product check makes it `allowed`.
   - Fixture A3: a food with no deterministic evidence and a cached facet that would flag it after the
     change. It is `unverified`, not admitted, and marked "Not verified" on a log.
   - Fixture B: a food with complete deterministic evidence of absence (a complete label that does
     not list a major allergen, or a whole-food class that rules it out). It is `allowed`, as today.
   - Fixture C: a food whose name names the allergen ("whey protein powder" for dairy), stored with
     `source = 'jev'`. It stays `blocked`, not merely `unverified`.
   - A property case: for any facet probability in [0, 1], fixtures A and A2 are never `allowed`.
2. A grep-level test shows that no allergen decision in `lib/policy/` reads `FoodFacetJudgments`.
3. A read-only production report counts held rows by allergen before merge, and the count after
   merge is equal (no hold was released by the migration).

One-line criterion: a food that only Jev flagged is never `allowed` before or after the change, a
food with complete deterministic absence evidence stays `allowed`, and no hold is released.

### W1. Universe v1

Builds the manifest (with sensory tags), the curated additions to `scripts/build-food-db.py` with the
JSON regenerated, an annotate script for evidence and `policy_categories` (branch first;
`--commit --production` is an owner step with the guard of `scripts/food-membership-audit.ts`),
`docs/catalog/universe.md`, and the review receipt.

Acceptance:
1. `tests/foods/universe-data.test.ts` passes for 100 % of items, with a count between 250 and 600:
   one active Foundation or SR Legacy food per item; finite, non-negative macros; positive energy;
   at least one part; non-NULL `policy_categories`; vocabulary-only cuisine and sensory tags; and a
   deterministic allergen state for every key in `ALLERGEN_RULES`, or a declared `unknown`.
2. A matrix of 12 cuisines (each with the base) × 8 rule profiles × 7 dates (4-meal days at 2,000
   kcal and 140 g protein) gives a plate in every slot on all 672 days.
3. The report lists, per allergen, the share of items that clear it.
4. The review receipt names a reviewer (question 3).

One-line criterion: every universe item carries complete deterministic evidence, and every cuisine ×
rule-profile day fills every slot.

### W2b. Food-world switch and the open-world gate

Builds migration 1, `lib/server/candidate-foods.ts` with the D4 admission order, the condition gate
(at opening and on every later condition edit), the `rulesVersion` watermark and its route,
the family Avoid match, the pure meal-level plate-rule check (kosher meat with dairy, D4), the
`OPEN_WORLD_HOLD_USER_IDS` hold, `POST /api/foods/world`, and the rule-revision freshness check. No
account opens yet.

Acceptance:
1. A property test over 500 seeded random rule profiles (allergens, categories, custom ingredient
   rules, preference flags, profile hard rules, Avoid families) and the full universe admits 0 foods
   whose `evaluatePolicy` verdict is not `allowed`, including arbitrary prior, graph and Jev outputs.
2. An Avoid mark on any family member removes every item of the family and every graph neighbour
   path into it.
3. A failed rule, Avoid or evidence read admits 0 foods and returns an error code.
4. A rule change on another device makes the next new-suggestion request refetch, and it admits
   nothing under the old revision.
5. An unconfirmed condition gets `409 condition_review`; a held account gets `423`.
6. A closed account's v1 and v2 `/api/foods/eligible` bodies are byte-identical to `main`.
7. The migration is in production, and 100 % of existing rows read `closed`.
8. The plate-rule check rejects every fixture plate that holds deterministic meat beside deterministic
   dairy for a kosher account, and every plate whose meat or dairy evidence is unknown.
9. **Clocks (admission-input versions, re-plan 2026-10-06).** A database test writes each table of
   the inventory (`lib/foods/world/admission-inputs.ts`) with an insert, an update and a delete: each
   transaction moves the matching counter by exactly 1, including an Avoid mark's `food_ref_id`
   swap, a family mark's `name_norm` change, a catalog description change and a nutrient amount
   change. One transaction writing several inventory tables moves it once. **Two concurrent Avoid
   writes on different families**, from two connections, move it by 2. A test asserts every
   inventory table has insert, update and delete clock triggers.
10. **Condition added after opening:** open a test account, then add "celiac" from a second client.
    The account returns to `closed`, rule review is required, and no new suggestion is generated on
    any surface (bread included, even when bread is Favored) until the user confirms. After the user
    confirms the celiac pack's gluten rule, bread is `blocked` and never generated.

One-line criterion: 500 random rule profiles and arbitrary scores admit zero non-allowed foods, every
write to an admission input moves its counter, a new condition pauses generation until confirmed, and closed
accounts are byte-identical to `main`.

### W2c. Jev off diet, religious and profile rules

Builds: preference-flag and profile hard-rule decisions without Jev facets
(`lib/policy/constraints.ts:349-355`, `lib/policy/profiles/hard-rules.ts:52-55`), with the same
fail-closed rule as W2a.

Acceptance:
1. For every preference flag and every frozen hard-rule facet, a fixture flagged only by Jev is never
   `allowed` before or after, and a Jev `absent` no longer clears a food without deterministic
   evidence.
2. A plain whole food that its class rules out stays `allowed` (the 2026-10-02 banana case).
3. A read-only impact report counts, per account, the Favored foods that move from `allowed` to
   `unverified`. It is attached to the PR before merge.

One-line criterion: no diet, religious or profile rule decision reads a Jev facet, nothing Jev-only
becomes `allowed`, and the impact count is attached before merge.

### W1b. Population prior and substitute graph build

Builds the D10 pipeline: the pooled 2017–March 2020 and 2021–2023 Day 1 prior for the national root
and the sex by age children, with release-specific estimates; the FNDDS-to-universe crosswalk audit;
licence receipts for every source; and the typed substitute graph (`tax`, `nutr`, `ctx`, `like`,
`comp`, D8 part 4). FlavorGraph stays out, and the excluded sources never enter.

Acceptance:
1. The build emits a manifest with sources, licences, mapping coverage, effective counts, calibration
   results, coefficient version and an artifact hash. A second run with the same inputs gives the
   same hash.
2. The respondent and cluster holdout report gives weighted hit@3, hit@10, NDCG@5, Brier score and
   calibration by decile, for pooled and release-specific estimates, national and sex by age, and the
   neutral baseline. Day 2 appears only as a sensitivity table.
3. Sex by age is enabled only with positive held-out lift that survives the mode-change check. Every
   cell under 30 effective respondents contributes little or no independent estimate.
4. The offline fairness audit reports ranking quality by the survey's race and Hispanic-origin
   groups. No artifact contains that field.
5. A licence check fails the build when any input comes from FlavorDB, FooDB, Recipe1M+, RecipeNLG,
   Instacart, Kilts NielsenIQ, Food.com or FlavorGraph.
6. **NCHS gate:** the build and the runtime load the NHANES-derived table only when
   `docs/decisions/2026-10-05-nhanes-aggregate-use.md` exists and the manifest names it. A test
   deletes the file in a fixture checkout and proves the prior is neutral (`P_f = 0`).
7. **The four ruling hard rules and the spec's H5 pass, each by its named check (D10):** H1 no respondent rows
   (`check-artifact.ts --no-respondent-rows` and the `.gitignore` test); H2 no `SEQN` or microdata
   joins (`tests/foods/nhanes-no-microdata.test.ts`); H3 no shipped cell under 30 effective
   respondents (`--min-effective-n 30`); H4 aggregate-only schema with the ruling path in the
   manifest (`--aggregate-schema`); H5, this spec's rule: race and ethnicity appear only in offline
   fairness audits and never in a shipped table, a snapshot or an account row
   (`--no-sensitive-axes` and the snapshot-shape test).
8. The server-only artifacts measure at or under 150 KB compressed, or the report states the measured
   size and the owner accepts it.

One-line criterion: a reproducible, licence-checked build ships a manifest, a holdout report and a
fairness audit; only children with positive held-out lift are enabled; the NHANES table loads only
under the owner's ruling; and the four ruling hard rules and H5 pass their named checks.

### W1c. Offline Jev pair labels and the pairing table

Builds the `pair_plausibility` purpose (D0); a batch script over fixed anchor-family × side pairs and
plate patterns, each with a stated occasion; an independent, human-labelled pair holdout across
cuisines; the calibration step; the co-consumption and compound features; and the bundled pairing
table with the D8 part 5 formula. The Jev weight ships at 0.

Acceptance:
1. The calibration report gives the Brier score, ECE and reliability curve of the raw and calibrated
   Jev labels on a human holdout of at least 400 pairs, and meets the §5 gate (Brier ≤ 0.18,
   ECE ≤ 0.05, at least 0.01 better than raw). Jev never grades its own labels.
2. A refresh with the same model id, prompt and rubric changes no stored probability.
3. No runtime import reaches the script or the Jev transport from `lib/meals/*` (import-graph test).
4. A curated "not with this" pair stays excluded, and no feature moves a scored pair below 0.3.
5. With the Jev weight at 0, the bundled table equals the table built without Jev labels.
6. **NCHS gate:** the NHANES part of `co` is built and bundled only when the ruling file exists and
   the pairing manifest names it; without it the table is built from the Ahn lists alone (test).
7. The NHANES co-consumption feature passes the same hard-rule checks as W1b (H1 to H5), run on the
   pairing artifact: pair rates only, each with its effective count of at least 30, no respondent
   rows, no `SEQN`, no race or ethnicity.

One-line criterion: Jev pair labels are calibrated on an independent human holdout, reproducible,
never on a runtime path, ship at weight 0, and never override a curated exclusion or the floor; the
NHANES co-consumption part ships only under the ruling and passes the H1 to H5 checks.

### W3. Eaten history and choice episodes

Builds `lib/meals/taste.ts`, `lib/server/taste-history.ts`, episode deduplication, the optional
`foodKey` on generated components, and `GET /api/foods/taste`.

Acceptance:
1. A fixture (30 days of logs, 2 eaten recipes with their slots and a duplicate log, 10 ticks, 1 mixed
   dish) gives exact `H`, `Q` and `M` values per identity (golden file), with each recipe meal
   counted once.
2. Deleting or moving an entry changes the values on the next read.
3. A two-account test shows that another account's rows never appear.
4. A food on Avoid or under a blocking rule contributes no personal evidence; removing the rule
   restores it.
5. Every read is bounded by date chunks and id batches.

One-line criterion: a fixed history gives exact deduplicated counts, edits show on the next read, and
no other account's rows appear.

### W4. FNDDS inputs for mixed dishes

Builds migration 3 and the import of FNDDS inputs, reusing the W1b crosswalk, through the branch-first
runbook in `docs/catalog/import.md` with sizing sign-off. Inputs come only from documented FNDDS
recipes; there is no `jev` source, and Jev does not decompose dishes.

Acceptance:
1. Inputs load for 100 % of FNDDS foods that list them in the source, with 0 unresolved codes.
   The `source` check accepts only `fndds`.
2. The sizing report keeps the architecture §7 headroom rule.
3. A logged FNDDS dish counts its inputs at half weight and marks them estimated; a dish with no
   inputs counts as itself only.
4. W4 builds the substitute graph's `ctx` term from FNDDS dish ingredient lists (public domain); the
   graph manifest names its source and licence; the term is empty until then. (Added 2026-10-06: the
   Ahn 2011 lists the spec first named are CC BY-NC-SA 3.0, so W1b ships `ctx` absent.)

One-line criterion: every FNDDS dish with source inputs gets resolved inputs, a logged dish counts
them at half weight, marked estimated, and the graph's `ctx` term comes from FNDDS ingredient lists.

### W5. Cuisines, optional country and taste storage

Builds migration 4, the `diet_prefs.taste` shape, and the sync mapping in `lib/sync/user-settings.ts`.
It reuses the existing birth year and sex for the prior's cohort. It adds no state, region, race or
ethnicity field.

Acceptance:
1. The profile sync contract (`tests/integration/profile-sync.test.ts`) covers create, update, omit,
   null and round-trip for `cuisines`, `country_code` and `diet_prefs.taste`.
2. Invalid values fail the database checks or the parser; a seventh cuisine fails.
3. Every existing `diet_prefs` writer keeps `taste` (a test like the one for `water`).
4. An account with no `country_code`, or a country other than `US`, gets a neutral prior; an account
   with `US` gets the U.S. prior (under the owner's NHANES ruling).
5. No AI payload carries `country_code`, sex or birth year.

One-line criterion: the new fields round-trip with the omit and null rule, invalid values fail, no
writer drops `taste`, and only accounts that chose the U.S. get the U.S. prior.

### W5b. Free-text preference chips

Builds the local safety-language check, the extended `/api/profile/prefs` questions (likes, taste
dislikes over universe families and sensory tags, cuisines), the onboarding taste-text field (up to 3
chips or one text), and the coach `confirm_taste_chips` card with Undo.

Acceptance:
1. Fixed sentences ("I can't stand mushy textures", "I grew up on Tex-Mex", "I love salmon") give the
   expected suggested chips at 0.8 or more on a recorded Jev fixture.
2. Keep-local fixtures return `route: "local"`, and the Jev port is called 0 times for every one:
   - rules and conditions: "I'm allergic to peanuts", "I have celiac", "I keep kosher", "my doctor
     says no grapefruit";
   - symptoms with no condition named: "soft food makes me vomit", "dairy gives me cramps", "beans
     make me bloated", "I get a rash after strawberries", "spicy food doesn't agree with me", "eggs
     upset my stomach";
   - unsure text: a 250-character paragraph, "I can't do X anymore" with an unknown X.
   A fixed corpus of at least 60 health and symptom sentences gives zero sends (no false negative
   allowed). Plain sentences ("I love salmon", "I hate mushrooms", "I grew up on Tex-Mex") are sent.
   The UI then offers the rule editor or asks for plain likes and dislikes.
3. Zero writes happen before the user confirms a chip (route and coach tests).
4. Jev down returns no chips, and the flow continues with manual chips.
5. A confirmed dislike lowers rank only; the food stays admitted.

One-line criterion: no health, symptom, rule or unsure text ever reaches Jev (0 sends on the fixed
corpus), plain likes yield chips, nothing is written until the user confirms, and Jev down only
removes the suggestions.

**As built (coordinator split, W5b round 4).** W5b lands the safety check, its gates on every taste
and preference Jev path, the chip suggestions (`POST /api/profile/prefs` with `{ taste }`, dark
behind `TASTE_CHIPS_ENABLED`) and a proposal builder attached to no reply. It writes NOTHING: there
is no confirm, no write to `diet_prefs.taste` or `cuisines` from a chip, and no Undo. Acceptance 3
(zero writes before a confirm) and 5 (a dislike lowers rank only) are met as "no writes at all
yet"; acceptance 5 is also pinned at admission by `tests/meals/taste-dislike-never-excludes.test.ts`.
The onboarding taste field and the coach card are the UI lane's once W5b-2 lands.

### W5b-2. Confirmed taste chips, written on the server

Builds the confirm write and its Undo on the server, so attribution never depends on a phone's copy,
a sync generation, a tab or a clock.

- **Confirm RPC.** One call takes the action id and the confirmed chips (dislikes in `tasteDislike`
  form, cuisines from the vocabulary). In one transaction, under a row lock on `user_settings`, it
  adds each chip the row lacks (never past the caps of 50 dislikes and 6 cuisines), keeps every other
  `diet_prefs` key, and records in an owner-only receipt table exactly the keys THIS call added. A
  repeat of the same action id returns the stored receipt and writes nothing.
- **Undo RPC.** Takes the action id. In one transaction it reads that receipt and removes only its
  added keys, and only those still present; a key gone since is left alone and reported. A second
  Undo is a no-op. It never removes a key the receipt did not record.
- **Phone.** The settings mirror updates from the RPC's answer (the row after the write); offline, the
  confirm waits and says so. The coach card applies through the RPC with the existing coach Undo
  record pointing at it.
- **Tests.** Overlapping confirms in one tab and in two tabs (the second requesting a key the first
  added); a confirm against a row another device already changed; a repeated confirm; Undo after a
  later manual removal; Undo of the second of two overlapping confirms leaves the first's key; the
  caps; every other `diet_prefs` key kept; RLS and a two-account check.

**As built (W5b-2).** Migrations `20261220090000` (the receipt table and the two RPCs),
`20261220090100` (`coach_action_undos.record_mode` gains `taste_v1`; `perform_coach_undo`
dispatches it to the receipt Undo; `record_coach_undo` never records or closes one) and
`20261220090200` (validates the two checks). The action id is a uuid the phone mints once per tap and
reuses for that tap's retries; it is an idempotency key only, never evidence of what was written. The
server write bumps the row's `rev` and writes a `change_log` row, so a phone op built before it
conflicts and is rebased; a phone `diet_prefs` edit replays only the sub-keys it changed, and a
`cuisines` or taste-dislike edit only the keys it added and removed. Undo removes only keys its
receipt still holds (`taste_chip_holds`; a key that left the row since, even if added again, is
the user's and is reported as gone). The coach card
is stored on the assistant message as `tool_calls.tasteChips`; a coach confirm is checked against it
and writes the coach Undo record in its own transaction. Contracts: §7.1.

### W6. Signal events with offered slates

Builds migration 5, `POST /api/foods/signals`, and the purge.

Acceptance:
1. RLS denies another user's select and insert.
2. Each event stores its offered slate; an event for a food that was not offered is rejected.
3. "Not this" and a taste dislike are stored apart.
4. The purge removes rows older than 180 days; a failed insert still answers 202.

One-line criterion: events are owner-only, carry their offered slate, never record an unoffered
negative, and never block a tap.

### W7. `pref-2`, pure

Builds `lib/meals/preference.ts` with `pref-2`, its constants and reasons; `PlateInput` gains the
quantized `z` values.

Acceptance:
1. With no `z` values, `rankPlates` and `planDay` are byte-identical to `main` on every `lib/meals`
   test and a new 365-date golden file.
2. Unit tests pin `w(12) = 0.5`, `w(36) = 0.125`, `w(60) = 0`; `z` stays in [−0.8, 0.8]; `G = 0` with
   direct evidence; a dislike spreads only on a sensory edge of 0.7 or more; "Not this" never spreads.
3. Monotonicity: raising `F`, `H` or `Q` never lowers a food's best plate; raising `L` or `N` never
   raises it.
4. `tests/meals/ranking-boundary.test.ts`: the module reaches nothing under `lib/policy/` and returns
   no verdict field.

One-line criterion: with no signals the layout is byte-identical to `main`, the formulas hold their
pinned values and directions, and the module cannot touch a verdict.

### W8. Snapshot v3, freshness, open layout and swaps

Builds the v3 route, the phone store and invalidation (extending O2's store), the open-world pool in
`resolveDay` and the swap sheet, the fit-first ordering, the meal-level plate-rule call inside the
plate search, and the search bound.

Acceptance:
1. An open account with 0 Favored foods gets a plate in every slot on 30 consecutive dates; a closed
   account is byte-identical to `main`.
2. Phone and server give identical plates for identical inputs (property test over 200 dates).
3. Over 365 dates, a food from an avoided family never appears.
4. With 3 Favored proteins over 4 slots and 14 dates, every slot fills and at least one slot uses a
   food that is not Favored.
5. A `sizePlate` counter stays at or below 20,000 for a 6-slot day; the largest snapshot is at most
   250 KB; the phone benchmark reports p95 scoring time against the 20 ms target.
   **Stated exception (orchestrator ruling, 2026-10-06; design finalized by a Sol re-plan after two
   failed reviews on an earlier, rejected trimming design):** the 250 KB cap is a hard guarantee for
   any realistic account (the bounded universe pool plus a normal Favored list) and a best-effort,
   logged target otherwise. The server NEVER drops a `foods` entry to meet it — not even a
   universe-sourced one: an omitted entry loses its `z`, reasons, history, facets and, under a
   meal-level rule, its plate evidence, so `openWorldInputs` (`lib/meals/open-world.ts`) would rank
   or rule on that food differently than the full admission intended (a kosher food with no plate
   evidence reads "unknown" and its plates stop generating), and an own (Favored) entry can be the
   only proof `admittedOwn`'s no-cached-ref fallback has that a food is admitted at all, which the
   server cannot see from a phone's local state. The wire shape is kept as slim as it safely can be
   (no redundant `parts`/`family` fields) instead. When the complete body still exceeds 250 KB — only
   when an account's own Favored data alone is that large; not observed, no cap on Favored count
   exists today — the server sends it complete anyway and logs the overage by section
   (`checkByteBudget`, `lib/server/meal-snapshot-v3.ts`). "Favored never limits meals" (§1) and
   ranking/rule correctness both win over the byte number. A follow-up tracks telemetry on this and
   whether a soft cap on Favored list size is needed.
6. A snapshot under an older `rulesVersion` or `evidenceVersion`, older than 7 days, or for another account gives no new
   suggestion.
7. The Phase 17 plausibility holdout runs on open-world and Favored-only plates; no cuisine is lower
   on open-world plates.
8. For a kosher account, no plate over 365 dates holds a meat food beside a dairy food.
9. A snapshot-shape test finds no cohort key, sex, age band, race or ethnicity field in v3.
10. **Cross-device rules:** device A holds a fresh snapshot that admits shrimp. Device B marks shrimp
    Avoid. Device A's next new-suggestion request sees a new `rulesVersion`, discards the snapshot
    and generates no shrimp. The same test runs for a diet-flag change on device B (vegetarian:
    device A generates no meat) and for a cleared Avoid mark (the food returns only after the refetch).
11. **Admitted set:** a bundled universe item absent from `admittedUniverseIds` (for example, one with
    unverified allergen evidence) is never generated on the phone over 365 dates, and the same holds
    for a local food whose ref is absent from `admittedRefIds`.
12. **Evidence correction:** an admitted food's stored evidence is corrected to `listed` for an
    allergen the account avoids. `evidenceVersion` moves, device A's next suggestion run refetches,
    and the food is not used in that run or any later one.

One-line criterion: an open account with no Favored foods gets a complete day on 30 dates, closed
accounts are unchanged, Avoid never appears, stale rules give no new suggestion, and phone and server
agree.

**As built (W8, 2026-10-06).** Everything below is dark: no account is open (`OPEN_WORLD_ENABLED`
unset), and a closed account's every request, body and plate is main's.

- **Wire.** The phone asks `GET /api/foods/eligible?v=3`. A closed account gets the v2 body byte for
  byte (`tests/foods/closed-world-eligible-bodies.test.ts`), so the v3 body always says
  `world: "open"`. A world that cannot be read (a DB error on that one check) answers `503` instead
  of guessing closed (Sol r3 BLOCK): that path carries no v3 token check, so a silent closed fallback
  could let an open account generate from a response D11's freshness guarantee never covered.
  Contract: `lib/meals/snapshot-v3.ts`. Deviations from D11's
  sketch: `z` is the W7 `TasteEntry` (`{ base, occasion? }`, only the occasions that differ, every
  value on the 0.01 grid or the whole body is malformed); per-food `occasion` is replaced by
  `history?` / `facets?` (the curated prior is recomputed on the phone, as in v2); `plate` (meat and
  dairy evidence) appears only under `plateRules: ["kosher_meat_dairy"]`; `eligible` (the v1 body)
  rides along for saved-line rule marks; `excluded` is the admission's `{ id, verdict, reason }`.
  The parser refuses any `foods` entry the admitted sets do not list.
- **Server** (`lib/server/meal-snapshot-v3.ts`): token t0, the v2 parts and the D4 admission over one
  eligible read, settings, the admitted taste history (W3), token t1; t0, the admission's token and t1
  must be equal, else `409 rules_changed`. A failed rule, Avoid or evidence read is `503`; a failed
  taste read only drops personal evidence. `pref-2` inputs are assembled in
  `lib/foods/world/taste-inputs.ts` (W7 open items: universe-id prior and graph mapped to name keys,
  the prior centred over the whole universe, `catalog:` keys and account copies resolved to one
  identity through the history's refs, account-level `M`; no sensory edges). Not supplied yet, each a
  follow-up: `R_f` (soft rules; condition packs are off), `N` and swap/Plan-sheet `Q` from W6 signal
  events, shopping/pantry (W11/W12), eaten foods outside the universe and Favored (no `perUnit` rows
  yet), the W1c pairing table (every non-curated weight is 0 and it has no rows, so reading it
  changes nothing).
- **Phone** (`lib/foods/eligible-client.ts`, `lib/meals/open-world.ts`): a held v3 snapshot serves a
  run only while `GET /api/foods/rules-version` reports its token; otherwise one refetch, used only
  under the token read right after it. Offline with an open snapshot: no new suggestion (owner
  question 6). The pool is the admitted refs' local foods plus admitted, countable universe items
  (`universe:<bundled id>`; nutrition from the bundle), less every family this device has marked
  Avoid since the read (`livePool`). `resolveDay` and the swap sheet use it with the snapshot's `z`.
- **Search** (`lib/meals/plate.ts` `OpenRanking`): 24 anchors per occasion (12 best by affinity ×
  e^z, 12 rotated by date), the kosher plate rule inside the search, and fit first (a fitting plate
  scores `10 +` its own score). Measured (60–100 dates, M4 Max, unrestricted admission, 124 foods):
  `sizePlate` at most 1,364 calls for a 6-slot day; `planDay` p95 12.8 ms for 4 slots and 18.4 ms for
  6. The 20 ms target is a phone figure: a phone benchmark is still owed before it is accepted.
- **Acceptance 7 is not run.** The Phase 17 plausibility holdout is an unreviewed seed whose labels
  cover its own pantry, not universe items, so it cannot judge open-world plates. It needs owner
  labels for universe plates per cuisine before any account opens (a release gate, not a code gate).
- Reason chips: `Meal.reasons` and `SwapAlternative.reasons` (`eaten_often`, `on_list`).

### W9. `compose_meal` on the pinned entry (O4b)

Builds `rankPinnedPlates`, the marked-row adapter, the incomplete named draft and the move to O4a's
parser.

Acceptance:
1. Every O4 re-plan regression case passes: cooked oatmeal band; yogurt with carrots; yogurt with oats
   beyond eight earlier Favored foods; paneer as anchor; apple with peanut butter; tuna with banana;
   a saved 10:30 slot; rice needing chicken when protein is met; yogurt needing a breakfast starch
   when carbs are met; a zero-nutrient named yogurt with added chicken; oats needing a second
   breakfast protein; a meal-only "breakfast"; catalog twins ahead of a marked chicken or beef;
   "salmon at lunch"; "breakfast burrito for dinner"; "for brunch"; "for a late dinner".
2. An incoherent named combination returns `incomplete` with a reason, `fitsTarget: false`, no fit
   note and 0 added foods.
3. A pinned food outside the shortlist is still searched, and it still passes policy.
4. The four-term cap test passes.

One-line criterion: every re-plan case passes, and an incoherent named combination returns an
incomplete draft with no fit claim and no added food.

### W10. Suggestions, recipes and the Jev short-list check

Builds `suggest_options` from `rankPlates` best plate per anchor over the pool, the recipe and planner
taste term, and the bounded short-list check (D9 item 4) with the veto in shadow mode.

Acceptance:
1. An open account with 0 Favored foods gets at least 3 admitted cards for each occasion.
2. Each run stays within three logical Jev calls (W089, `MAX_LOGICAL_CALLS`); the ranking call is on 5 to 8 admitted plates, with no retry, inside
   `SUGGEST_BUDGET_MS`.
3. The request payload holds only generic candidate identities and meal descriptions: a payload test
   finds no profile, rule, medical note, account identifier or custom food name.
4. With Jev down, slow, invalid or vetoing too much, the formula order is returned unchanged, and at
   least 3 cards remain.
5. The check never adds a candidate and never puts a plate that misses fit ahead of one that fits.
6. Shadow mode: until the §5 veto gate passes (≥ 95 % precision, interval lower bound ≥ 90 %, at
   least 60 vetoes, timeouts ≤ 5 %, p95 added latency ≤ 1.5 s), a veto
   changes no output and is recorded as a review reason.
7. Of two recipes that differ only in one Favored ingredient, the Favored one ranks first.

One-line criterion: open accounts get at least three admitted cards per occasion; Jev makes at most
one bounded, no-retry call with no profile or rule data that cannot add or promote past fit; vetoes
stay in shadow until the precision gate passes.

### W11. Shopping signals and focus mode

Builds the D7 signals, migration 6, the `use_shopping_list` intent and the `set_shopping_focus`
action with Undo and golden files.

Acceptance:
1. With focus on, every slot whose template can be met from list and pantry foods gets the highest
   coverage available inside the portion bands.
2. A checked line boosts exactly inside its time box (tests on the day before, first day, last day
   and day after).
3. An unchecked planner line never boosts.
4. An account without shopping access gets a clear refusal and no write.

One-line criterion: focus mode takes the highest list coverage inside the bands, boosts start and
stop on their boundaries, and the coach toggles focus with Undo.

**As built (UI, W100).** `components/ShoppingFocusToggle.tsx`, inside Shopping's plan notice: "Use my list" calls `writeShoppingFocus` (`POST /api/shopping/focus`, the server picks the end), shows "until <day>", and offers Undo for the last write. Undo answering `superseded` leaves the newer choice in place and says so. It only exists inside Shopping, so an account without Shopping access never sees it. Tests: `components/ShoppingFocusToggle.test.tsx`.

### W12. Pantry from a photo

Builds the photo route, migration 7, and a privacy boundary before any byte leaves the server.

**Today's exposure (a follow-up, not caused by W12).** `photoToIdeas` sends the full image to the
provider as a data URL (`lib/ai/openrouter-payloads.ts:63-70`). This already happens for every
Plan-sheet photo. The Plan lane already meets part of the boundary: the phone re-encodes the photo
through `resizeImage` (`lib/plan/inspire-client.ts:35`), which drops EXIF at 1600 px
(`lib/media/resize.ts:2-3`, `:13`); every OpenRouter request routes with `data_collection: "deny"`
and `zdr: true` (`lib/ai/openrouter.ts:97-101`); and the account's rules never reach the model
(`lib/server/plan-inspire.ts:11`). It does not show a notice, and the server does not verify that
an upload is free of metadata. **Follow-up (slice item W12-F):** apply the same notice and server
metadata check to the existing Plan-sheet photo path.

**Owner decision (2026-10-05).** The owner chose this boundary: user-started capture, the notice,
zero-retention routing, no profile or rule data, and EXIF stripped. The owner **accepts in writing,
on 2026-10-05,** the remaining risk that visible pixels (for example a prescription label left in
frame) reach the provider. No pixel-level redaction is built in Phase 18. The decision is recorded in
`docs/decisions/` when W12 starts, citing this section.

**The W12 boundary:**
1. The user starts every photo; nothing is captured or sent automatically.
2. Before the camera opens, one line asks the user to keep medicines, prescriptions and labels with
   names out of the frame.
3. The phone downscales and re-encodes the photo with `resizeImage` (on-device, EXIF dropped).
4. The server strips any remaining EXIF, XMP, GPS or other metadata block before the call, and
   refuses a file it cannot parse. This is new in W12; the Plan path does not do it today.
5. The call goes only through the OpenRouter `photoToIdeas` pin with the deny and zero-data-retention
   routing above (`lib/ai/openrouter.ts:101`). If that lane is unavailable, W12 fails with "Try again
   later" and does not use the Gemini fallback, because the zero-data-retention routing is an
   OpenRouter setting.
6. The prompt is the fixed `photoToIdeas` prompt with no slot calories. No profile, rule, condition,
   medicine, account id or name is sent.
7. The server keeps only `kind: "ingredients"` food names from the answer.

Acceptance:
1. A fridge photo fixture gives a draft and 0 pantry rows before the user confirms.
2. Confirming writes one row per confirmed item with `source: 'photo'`; null grams are allowed.
3. A blocked or unverified item is marked, never hidden, and no photo judgment clears an allergen.
4. Each photo writes exactly one `ai_calls` row under `photoToIdeas`, and the photo is deleted by the
   24-hour sweep.
5. A fixture JPEG with EXIF GPS tags reaches the payload builder with no metadata block (byte test),
   and an unparseable file is refused before any provider call.
6. A payload test proves the request holds only the fixed prompt and the image: no profile, rule,
   condition, calorie or account field.
7. With OpenRouter unavailable, the route answers an error and makes 0 Gemini calls.
8. The notice text is present before capture (UI hand-off test).

One-line criterion: a user-started photo, stripped of metadata and sent only through the
zero-retention lane with no account data, yields a confirm-first draft; only confirmed items reach
the pantry and boost, and no photo judgment clears a rule.

### W13. Favored rename, star merge and account move-over

Builds the open default for new accounts, the onboarding completion write, the open-world starter
change, the star-to-Favored script (branch first, owner `--production` step) and the invitation API.
UI lane: copy, the star toggle and the invitation. The §9 AGENTS.md rules land here.

Acceptance:
1. A copy test finds no user-visible "Eats" in `components/` and `app/` outside an allowlist.
2. Wire names are unchanged: the sync op and coach golden files differ only in copy.
3. The star script converges on a branch (a second run makes 0 changes) and never overrides Avoid.
4. A held account never sees the invitation and stays `closed`.
5. A new account onboarded after the deploy is `open` with 0 default or inherited Favored marks.
6. An existing account that opts in keeps its Eats marks as Favored marks, unchanged.

One-line criterion: no user-visible "Eats" remains, wire names are unchanged, the star merge is
idempotent and never overrides Avoid, and new accounts start open with no default Favored foods.

**As built (UI, W098).** Settings › Food ideas (`components/settings/FoodWorldSection.tsx`) and a dismissible card on the Foods first tab (`components/foods/OpenWorldInvitation.tsx`) read `GET /api/foods/world` and `GET /api/foods/world/invitation` through `readFoodWorldView`, and write with `chooseFoodWorld` (`POST /api/foods/world`, no `intent`, pending onboarding default cleared first). Both render nothing while the account is closed and not eligible (held, unreleased, or a failed read). A 409 `condition_review` shows a plain review line; the confirmation flow itself is not built here. Copy says "Favored", never "Eats"; the wire name is unchanged. The star toggle is covered by `tests/favorites/food-star-toggle.test.tsx`; no account is opened by this change.

### W15. Onboarding question ablation

Runs the §5 onboarding test on the opt-in pilot for the cuisine screen and the taste chips.

Acceptance:
1. The report gives, for each question, the NDCG@5 lift with a 95 % cluster-bootstrap interval,
   completion time and abandonment.
2. A question that misses the 1-point gate or loses completion moves to Settings in the same PR.

One-line criterion: each optional onboarding question stays only with a measured lift of at least 1
point NDCG@5 and no completion loss.

### W14. Taste T2 behind the gate

Builds migration 8, the trainer, the leakage-free replay harness and the report in `docs/evals/`.

**Definitions.**
- A *decision* is an offered slate (from W6) after which the user picked, swapped to or ate an
  anchor from that slate.
- A *distinct slate* is a unique set of offered anchor food keys at one occasion.
- *Anchor diversity* is the number of distinct anchor food keys across the account's offered slates.

**The gate, per account (pass only if every line holds):**
1. At least 30 decisions, from at least 20 distinct slates, over at least 14 distinct days.
2. Every counted slate offers at least 5 distinct anchors. Slates with fewer are not counted.
3. Anchor diversity of at least 10.
4. A time-forward split: train on the earliest 70 % of decisions, test on the latest 30 %, with at
   least 10 test decisions. Nothing from the test period enters training.
5. On the test fold, T2's hit@3 is at least 5 points above `pref-2`'s, and the 95 % confidence
   interval of the difference, from 1,000 paired bootstrap resamples by day, has a lower bound above 0.
6. Exclusion sets are identical, and mean macro fit drops by no more than 1 point.

**Why these numbers.** With 5 anchors per slate, random hit@3 is 60 %, so a 5-point gain is a real
change; with 3 anchors hit@3 would be 100 % and mean nothing. 20 distinct slates and 10 distinct
anchors stop one repeated slate from deciding the result. Resampling by day keeps meals of one day
together, because they are not independent. 30 decisions with 10 in the test fold is the smallest
replay where a 5-point gain can clear a bootstrap lower bound above 0 with plausible variance. All are
starting values, to be tightened, never loosened, after the first replay report.

Acceptance:
1. The replay uses only information known before each offer.
2. The report prints, for each account, every gate line with its value and PASS or FAIL. T2
   activates only for an account where every line passes.
3. Fixture accounts prove the outcome: one with 30 decisions but 3 distinct slates FAILS line 1; one
   with 4-anchor slates only FAILS line 2; one with a 5-point gain whose interval includes 0 FAILS
   line 5; one that meets every line PASSES.

One-line criterion: T2 activates for an account only when it has at least 30 decisions from at least
20 distinct slates of at least 5 anchors each, and the time-forward hit@3 gain is at least 5 points
with a day-bootstrap 95 % lower bound above 0 and identical exclusions.

## 11. Risks and proof

| Risk | Proof or guard |
|---|---|
| Open-world plates look odd. The O3 run (2026-10-05) scored generated plates 25 to 81 % plausible against an 85 % gate. | W8 acceptance 7, the Jev pair-label eval, and the shadow-mode veto. |
| A visible label in a pantry photo reaches the provider. | Accepted in writing by the owner on 2026-10-05 (W12), after the notice, metadata strip and zero-retention routing. |
| Corrected food evidence is missed by a cached snapshot. | The global `evidenceVersion` forces a fresh admission read (D11, W8 test 12). |
| Taking Jev off the rules path hides foods that Jev cleared before. | W2c's impact count before merge. Holds are reviewed, never silently released. |
| NHANES data are misused. | The owner's ruling, its four hard rules and the spec's H5, each a named build check (D10, W1b, W1c). Without the ruling file the model runs with a neutral prior. |
| Health text leaks to Jev through the taste box. | The conservative local check with a zero-send health corpus (W5b). |
| A pantry photo shows a medicine label. | The W12 boundary: notice, metadata strip, zero-retention lane, no account data. |
| A rule change on another device is missed. | A trigger-bumped account rules counter and the cross-device tests (D11, W2b, W8). |
| The U.S. prior does not fit users elsewhere. | It applies only to accounts that chose the U.S., fades with personal evidence, and other countries wait for their own build (question 1). |
| The pooled releases differ (the 2021–2023 telephone mode change). | Release-specific estimates beside the pooled one; sex by age is disabled if its gain does not survive the mode-change check. |
| The prior performs unevenly across groups. | The offline fairness audit by the survey's race and Hispanic-origin field. The fix is never a race node. |
| A data source turns out not to be licence-safe. | Licence receipts in the manifest, a build-time licence check, FlavorGraph held, and the excluded list (D10). |
| FNDDS recipe inputs are estimates. | They are marked estimated and count at half weight. Their public-domain status is [ESTIMATE] and is confirmed before W4 ships. |
| Allergen avoiders get thin pools. | W1 reports the clear rate per allergen; the matrix test proves a full day for common profiles. |
| The phone layout gets slow. | The D11 search bound, the `sizePlate` gate and the phone benchmark. |
| An old phone reads an open account. | An old client never asks for v3, so it generates from Favored only, which is safe. |
| The individual T2 gate is noisy. | Time-forward holdout, an interval that excludes zero, and distinct-slate minimums. |

## 12. Open questions for the owner

Each question carries a recommendation. Sol's pass-2 questions (§H) are merged here with the earlier
ones; none is listed twice. The NCHS questions are closed by the owner's ruling
(`docs/decisions/2026-10-05-nhanes-aggregate-use.md`).

1. **Launch geography.** Apply the U.S. prior only to accounts that chose the U.S., and defer Canada,
   Mexico and state priors?
   *Recommendation:* yes. Other accounts get the neutral prior until a validated country model
   exists. No state or region question.
2. **Third-party data rights.** Run a rights check on FlavorGraph's upstream recipe data and on the
   UK Biobank liking files, or ship without them?
   *Recommendation:* ship without FlavorGraph. Add the UK Biobank aggregates only after their reuse
   terms are confirmed; until then the `like` term is absent and adds nothing. Never use FlavorDB,
   FooDB, Recipe1M+, RecipeNLG, Instacart, Kilts NielsenIQ or Food.com.
3. **Clinical sign-off.** Who signs off on the universe evidence, the cuisine tiers and the wording
   for opening an account with a stated condition? Does v1 ship all 12 cuisines?
   *Recommendation:* the owner reviews the universe and the tiers; a qualified clinical reviewer
   approves the condition wording. Ship only the cuisines that pass the W1 matrix with reviewed
   tiers.
4. **Conditions.** Is the user's own per-condition confirmation, in reviewed wording, enough to open
   the food world for an account with a stated condition? (`CONDITION_PACKS_ENABLED` is still off,
   pending the owner's review of the pack wording.)
   *Recommendation:* yes, once the clinical reviewer approves the wording. Until then, accounts with
   a stated condition stay closed.
5. **Existing accounts.** Should the first client and other existing accounts receive the open-world
   invitation, and should their Eats marks become Favored marks?
   *Recommendation:* keep the first client held (`pref-0`, no invitation). Invite other existing
   accounts only after the safety and plausibility gates pass, and keep their current Eats marks as
   Favored marks when they opt in.
6. **Offline safety.** Is showing the last plan while withholding new suggestions until the rule
   revision is confirmed fresh the intended behaviour?
   *Recommendation:* yes. An offline phone cannot prove that another device did not add an allergy.
7. **Cross-user learning (T3).** Keep it out of scope, or commission a consent and privacy design?
   *Recommendation:* keep it out of scope. Revisit only after the personal model is proven, and then
   with a separate consent and privacy design.
8. **Shopping gate.** Should W11 and W12 expand beyond the current shopping pilot?
   *Recommendation:* keep both pilot-only until the shared recommendation score and the
   confirm-first pantry flow pass their release checks.

## 13. Out of scope

Branded or Open Food Facts items in the universe; micronutrient goals; geolocation; prices; writing
condition packs; changing what logging accepts; any new model vendor; any race or ethnicity input;
state, region and Canada priors; EPIC-Oxford re-ranking; NCI usual-intake modelling; learned
embeddings; activity as a prior axis.
