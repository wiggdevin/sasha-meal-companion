# Foods annotations worker report — 2026-09-27

Branch: `feat/foods-annotations`. This worker made no commit, push, production write, or database-mutating test. Root reviewed/applied the A08 migration in the local clone and working local database; see `migration-hardened-local-proof.txt`. `YES` below means verified in source or a focused non-DB test unless stated otherwise. Overall acceptance remains **NO** until the required two independent verdicts and browser checks occur.

## Reproduction and cause

- Screenshot `recipe-policy-error.png`: American, 15 minutes, Any effort. It mixes an actual Avoid block for cooked salmon with repeated `facet_evidence`/`policy_unknown` messages for most other ingredients. `findRecipeCandidates` flattened every ingredient reason into user-facing `limitations`.
- `pilotRecipes()` has 29 distinct bundled FoodDB ingredient IDs. Seeding maps each to a catalog revision only on an exact, unique active USDA description. The candidate loader previously requested evidence only for non-null `catalogFoodRevisionId` and did not load cached facets even when mapped. The bundled ingredient branch supplied `{}`.
- Read-only local test database through `local-run.py`: one active catalog version, **36 active food revisions**, `catalog_search('bean')` returned **0** with no RPC error, and there are **0** descriptions containing `bean`. Exact active catalog matches exist for **0/29** pilot FoodDB IDs. `scripts/repair-recipe-food-mapping.ts` dry run: `checked=62`, `repairable=0`, `updated=0`, `ambiguous=62`. This is a local fixture coverage gap. Root's separate read-only production audit found 13,694 active foods, 488 bean rows, 29 exact stable SR source IDs and only one cached facet among them; see `root-live-evidence.md`. Recipe mapping and facet warm work has transferred to the layout worker.
- The search client now uses real bundled FoodDB identities when a healthy authenticated catalog search returns no hits. It labels them as built-in rows, retaining the existing membership write path. The database itself still needs a catalog import or exact mapping to supply revision-backed recipe evidence. The repair script refuses non-loopback targets and defaults to dry run.

## A01 — Diet style

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Tap card opens editor for style and exclusions; values editable freely | YES | `AvoidsView.tsx` offers all 12 validated `PREFERENCE_FLAGS` as touch controls; root opened Vegetarian in mobile browser. |
| Explicit confirmation previews change; cancel preserves values | YES | Review and Confirm are separate states; root's local mobile browser saw the Vegetarian preview and Cancel preserved no selected style. |
| User and coach use consistent validated owner-scoped persisted values | YES, source/test | `GET /api/foods/diet` uses `requireUser`; save folds validated flags into the same atomic `user_settings` outbox used by coach profile edits. The direct PUT was removed. The editor checks the displayed server rev, drains queued settings, and rereads the persisted flags before success. Focused client tests cover an existing pending lifestyle edit, queued failure, stale rev, and account switch. Coach and recipe loaders already read the server field. No live account test. |
| Reload and suggestions reflect change; other users unchanged | NO | Source rereads on mount and after write, but no authenticated two-account browser or suggestion proof yet. |

## A08 — Custom rules

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Add, persist, edit and remove free-text rule | YES, local browser/database | `AvoidRules.tsx` uses existing `/api/constraints` revision-checked PUT; migration validates each JSON item and guarded down refuses nonempty rules. Root's local SQL proof passed malformed/duplicate/CHECK/down cases. Browser save initially failed because authenticated column grants were missing; root applied the narrow local grant delta, then added garlic as Guidance, edited it into Ingredient, removed it, and verified reload persistence. Local owner isolation SQL passed. No production SQL. Failed UI save kept the draft and showed error. |
| Supported ingredient/cuisine exclusions apply consistently to recommendations | PARTIAL → NO | `evaluatePolicy` handles literal ingredient and available subingredient text; a prepared food with no complete label remains unverified, while a whole single-ingredient identity is not blanket penalized. Recipe eligibility blocks matched cuisine and makes missing cuisine unknown. Malformed stored rules fail closed at profile load and make direct policy calls unverified. Catalog, barcode and log profile readers select `custom_rules`. Layout worker owns candidate evidence loading; no end-to-end proof. |
| Unsupported/ambiguous guidance distinguished from enforced exclusion | YES, source | Default kind is Guidance only. An attempted supported rule such as “no garlic” is rejected with a literal-name instruction; unsupported guidance remains visible but not filtered. UI says derivative coverage is not proven. |

## A10 — Avoid-food search

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Reproduce bean empty result and repair data/API path | PARTIAL → NO | Local RPC returned zero because the 36-row local catalog has no beans. `lib/catalog-client.ts` now falls back to actual bundled FoodDB rows on zero hits. Production cause and import state unverified. |
| Semantic aliases, partial names, typo-tolerant results | PARTIAL → NO | Existing catalog RPC has synonym/trigram scoring; bundled FoodDB scorer supports prefix and subsequence matches. No browser or representative query corpus run. |
| Selection persists into Avoids; reload/suggestions/account isolation | NO | Existing membership path is retained. Other worker owns the selection UI; no authenticated persistence test. |

## A09 — Conditions feedback in owned rules card

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Explicit submit and Enter save; blur does not save | YES, local browser | `AvoidRules.tsx` uses a controlled draft and Save conditions button; both paths clear the draft only after an acknowledged save. No blur handler. Root verified Save/reload and Enter clearing the draft in the local browser. |
| Save control has visible submit icon | YES, source | The existing `SendGlyph` now appears beside “Save conditions” in the same button; its accessible name, disabled state and feedback hooks remain intact. Focused lint, type and diff checks passed. Root owns visual retest. |
| Success glow; error preserves input and does not glow | YES, source | The shared `useActionFeedback` primitive receives a rejected operation on conflict/error. It controls success glow, error toast and disabled pending state. No browser motion test. |
| Approximate 2-second haptic envelope with fallback/reduced motion | PARTIAL → NO | Shared feedback primitive invokes the reviewed haptic helper and a visual fallback. Device haptic support and envelope were not measured by this worker. |

## A11 — Avoid card and affected plans

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Avoid card at top and thin Add footer | YES, source / NO visual | `AvoidImpact` now renders `AvoidFoods` first. MyFoods worker supplied a full-width Add footer and badge callback API. Root owns mobile browser review. |
| Ingredient/cuisine intent kept distinct | YES | `AvoidImpact` requires explicit kind; cuisine is checked against recipe cuisine, never stored as an ingredient mark. |
| New Avoid scans future plans; blocked candidates not actionable as safe | PARTIAL → NO | Acknowledged Avoid changes trigger a fresh owner-scoped scan; generated unsaved cards and opaque swaps are not enumerable. Candidate policy blocks Avoid identities, but root still needs action-time browser/database proof. |
| Exact per-avoid count badge and instance modal | PARTIAL → NO | `AvoidFoods.renderAvoidStatus` shows per-row counts from one owner-scoped batch read; click opens instance details. The scan now matches saved food-ref/catalog IDs, bundled FoodDB IDs, and comma-base names (for example, “Black beans, cooked” vs “black beans”). Missing or malformed ingredient snapshots, unresolved prepared-food subingredients, opaque edits/swaps and capped scans display a lower bound, never an exact zero. Eaten/removed slots are excluded. Full identity and browser proof are still needed before calling counts exact. |
| Inline edit/remove/remix with gestures and accessible controls | PARTIAL → NO | Modal now has explicit buttons and left-remove/right-remix gestures. Remove uses existing `saveItemOverride` plus before/after sync and reports pending state; Remix ranks up to 64 policy-eligible recipes by cuisine, tags, name and time, then opens existing preview/accept; Edit reopens an eligible original recipe. No database or browser proof of conflicts, selection supersession or gesture behavior. Edited non-recipe meals still lack a true inline edit. |
| Ask Sasha targeted replacement context and similar options | PARTIAL → NO | Modal selects exact owner-scoped date/slot instances, rereads them before a suggestion-only `postTurn`, and shows policy-allowed structured food ideas plus advisory reply. No plan action is applied by the response; Remix/RecipePlanFlow remains the confirm path. Root must prove output quality and context in browser; this is an in-modal call, not a composer handoff. |
| Relevant settings editable in modal | YES, source | Modal embeds the same `AvoidRules` and `DietStyleCard` editors. |
| Consumed actual history preserved | YES, source | Impact GET excludes eaten slots and performs no writes. No plan/history mutation was added. |

**MyFoods integration received:** the UI worker added `renderAvoidStatus` and `onAvoidSaved` props. This worker consumed them in `AvoidImpact` without editing `MyFoods.tsx`.

## Cross-cutting recipe evidence

| Exact criterion | Verdict | Evidence / limit |
|---|---|---|
| Reproduce screenshot query and separate unavailable evidence from real Avoid | YES, source | Screenshot and pure test in `tests/recipe-catalog/boundaries.test.ts`; Avoid and evidence remain separate codes. No authenticated browser reproduction. |
| Repair legitimate mapping/DB access failure without weakening checks | PARTIAL → NO | Candidate loader now exact-maps FoodDB USDA names to a unique active revision and reads cached facet evidence; bundled USDA category mapping is reused. Missing/ambiguous evidence remains unknown. Local fixture has no exact matches; repair cannot fill it. |
| Concise actionable reason without diagnostic flood | YES | `summarizeExclusions` emits at most two user-facing lines for Avoid conflicts and evidence gaps; focused test passes. |
| Legacy rule review explained with direct link instead of generic 409 | PARTIAL → NO | Server uses `rule_review_required`; another worker's recipe client now exposes typed `RecipeSearchError`. A direct UI link to `/foods#avoids` needs recipe UI integration/verification. |

## Focused checks

- `mise exec -- pnpm exec tsc --noEmit --pretty false`: exit 0 after follow-up edits.
- Focused Vitest over diet client/route, impact route/ranking, rule parser/policy/UI and recipe policy: the prior 10-file run passed; subsequent focused diet/impact run passed **11 tests across 2 files** after catalog-ID detail, null-ID and swapped-selection regressions. Existing Vite native-loader warning only.
- After root's single combined full-suite run exposed stale test doubles, the two constraints fixtures were updated to include the new `custom_rules` column and the no-row expectation. A focused rerun of constraints route/defaults and four coach turn specs passed **105 tests across 6 files**. The coach fixtures had already been updated by another worker. Stored-rule validation remains strict.
- A11 modal follow-up: errors and notices now render inside the open affected-meals dialog, including an Ask Sasha provider failure, and return to the section when the dialog closes. Remove/Remix swipe actions require more than 60 px of horizontal travel and horizontal dominance; touch cancellation clears the gesture. Focused impact gesture/route run passed **7 tests across 2 files**; focused ESLint, TypeScript and `git diff --check` exited 0. Root owns browser confirmation.
- A11 replacement follow-up: Ask Sasha and Remix now share one owner-guarded catalog search and exclusion-filtered similarity selector. Ask Sasha passes at most 12 exact selected instances and two bounded verified recipe names per instance to the coach; eligible catalog choices remain visible per instance even when the coach fails or says none, and each choice enters the existing portion preview/accept flow. Free-text coach ideas stay advisory. Focused impact selector/route/ranking run passed **9 tests across 3 files**; focused ESLint, TypeScript and diff check exited 0. Root owns live retest.
- Focused ESLint over owned changed TS/TSX files: exit 0.
- `git diff --check`: exit 0.
- Read-only local database checks above. No full suite, browser QA, independent model review, migration application, or production check in this worker.

## Release blockers for root

1. Root applied `20261203090000_custom_food_rules.sql` in the local working database after clone up/down proof. Browser reload and account-specific persistence remain unverified.
2. Verify the layout worker's stable-source mapping and subingredient evidence against the local DB, then action-time recipe policy. This worker did not edit their mapping files after ownership transferred.
3. Verify the plan-day outbox removal against concurrent consumed-state writes. The current source has a local eaten guard and pre/post sync but no atomic database proof. Validate name-based impact counts against canonical aliases and subingredients before calling them exact.
4. Run authenticated browser, account isolation, persisted reload, history preservation, independent verdicts and CI gates. None are inferred from type checking.
