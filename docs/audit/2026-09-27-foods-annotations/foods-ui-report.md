# Foods UI implementation report

Branch: `feat/foods-annotations`. Source freeze: 2026-09-27. No commit, push, or production action from this worker. The final note migration was applied only to a disposable local clone and the working local database after a verified backup.

## Changes

- Added reusable `GlassSelect` to the existing UI library. It uses a scrollable, high-contrast glass listbox with selected and disabled states, keyboard controls, touch/click, accessible labels, form name support, and a portal that stays inside a sheet dialog when present. Migrated the recipe, plan, onboarding/body-profile, and settings selectors that this worker owns.
- Moved recipe discovery below usual foods, inside Recipes. Search has an icon button at the far right of its input; Enter submits. Cuisine takes the full mobile row, with minutes and effort sharing the next row; wider layouts use three columns. A separate New recipe action keeps the existing creation sheet. Saved recipes retain edit and now have a confirmed soft-delete action.
- Added a full-width Add footer to each protein, carb, fat, and Other usual-food card. Category adds preselect and persist that category. Rows reveal Remove on a left swipe; the same button is keyboard and screen-reader accessible. Remove clears membership to neutral without deleting the account food row or logged intake. The existing Other foods area lets a user re-add it.
- Expanded the food sheet with explicit Save changes, saved/error feedback, editable note and group, and nutrition editing for account-owned foods with a known gram conversion. Group and nutrition edits use revision-bound, complete-row `apply_sync_op` calls and update the local sync mirror; both reach other devices through `change_log`. A narrow `save_food_note` RPC draft handles name-wide note edits and explicit clearing without replaying Eats/Avoid status. Its row revision plus expected-note guard rejects stale forms. An explicit-note authority marker makes older queued membership operations with non-NULL notes unable to restore a cleared note. Mapped catalog nutrition stays read-only; canonical catalog rows and consumed history are not edited.
- Recipe search now presents typed server errors. A `rule_review_required` response links to Foods › Avoids for the existing rule review card, rather than showing a generic status number. Eligibility errors are not hidden or downgraded to empty results.
- The Add food search now shows bundled results when the catalog has no match, labels them “Built in,” and adopts a selected food through the existing account-owned bundled mapping. Re-adding keeps a prior note, role, and nutrition. Search and add callbacks ignore stale account results and present actionable failures.
- Avoid foods now use the same glass card and thin bottom Add footer as Eats, including when empty. `AvoidFoods` exposes optional `renderAvoidStatus(food)` and `onAvoidSaved(food)` props for the rules-owned per-food impact UI. Saves merge onto the current row after the account check, so a delayed edit cannot revert a newer membership change. Foods and Recipes clear their sheets and lists on account switch; recipe removal rejects an out-of-date revision.

## Acceptance status from this worker

| Annotation | Source implementation | Remaining evidence gate |
|---|---|---|
| A02 | YES | Root's final touch/keyboard/browser review. |
| A03 | YES | Root must capture the corrected mobile filter layout; its first-pass screenshot preceded the correction. |
| A04 | YES in source and local database | Root's final browser and cross-device acceptance evidence remains. Clone and working-local SQL proof is in `note-migration-local-proof.txt`. |
| A05 | YES | Browser proof for all four cards and empty card remains. |
| A06 | YES | Browser placement and Enter/search-icon proof remains. |
| A07 | YES | Browser create/edit/delete/reload proof remains. |
| A13 | NO | Shopping worker owns the final `ShoppingIngredientPicker` migration; app-wide browser audit remains. |
| A14 | YES for shared component/API/docs/tests | App-wide adoption closes with A13. |

Source YES means implemented and checked locally. It is not a claim that the acceptance document's two independent verdicts or final browser evidence are complete.

## Focused validation

- `mise exec -- pnpm exec tsc --noEmit --pretty false`: exit 0.
- Scoped ESLint on changed TypeScript and tests with `--max-warnings 0`: exit 0.
- `GlassSelect.test.tsx`: click, selected/disabled state, keyboard, dialog portal, and unknown-value fallback pass.
- `recipes-client.test.ts`: 6/6 pass (including revision-bound soft delete).
- `prefs-client.test.ts` and `food-edits-sync.test.ts`: revision-bound complete-row sync, stale-status avoidance, explicit note clear, offline note failure, queued initial membership, nutrition conflict/partial save, and mapped-catalog guard pass.
- `add-food-bundled-fallback.test.tsx` plus `re-add-keeps-note.test.ts`: 5/5 pass (bean fallback is visible, selectable, and preserves prior metadata).
- Final focused run: `add-food-bundled-fallback.test.tsx`, `food-sheet-save.test.tsx`, `re-add-keeps-note.test.ts`, and `recipes-client.test.ts`: 16/16 pass. This covers actionable search rejection, stale account search suppression, explicit food edit save/failure feedback, and refusal to remove a recipe changed after the sheet opened. Scoped ESLint and `tsc --noEmit` also exit 0 after these changes.
- Final scoped run after the audit fixes: 10 files, 90 tests pass. `mise exec -- pnpm exec tsc --noEmit` and scoped ESLint exit 0. Tests cover stale note forms, explicit clears, a legacy queued status carrying an old note, a subsequent deliberate coach note, and coach Undo routing. These exercise the client/RPC contract with a fake server. Root's browser pass observed Recipes placement, Add footers, and the glass popup.
- After the combined-suite audit, four focused files pass: 57/57 tests. A queued membership operation with `note: null` now asserts note preservation because explicit clearing uses `save_food_note`; recipe-access coverage renders the moved Recipes section; card copy reflects the in-card Add footer; Avoids SSR waits for the local list. An added interaction test confirms editing an existing Avoid note does not open the new-exclusion impact flow.
- The final note migration (SHA-256 `85686f837109b140124638878c53c97bce43de8faddfcc2162de1637bfcdbc35`) passed nine synthetic behavior checks, guarded down/up, privilege, and unlogged-overwrite tests on a local clone. It then applied transactionally to working local Postgres with a schema reload. See `note-migration-local-proof.txt`. No production database was changed.

## Audit fixes and remaining gate

- Addressed Opus findings 1–16 in owned source: complete-row logged sync writes, first-write Avoid targeting, no status replay from edit saves, partial-save projection, Avoid Remove Undo, deliberate Avoid-to-Eats re-add, mouse/scroll/dirty-form controls, server-mapped nutrition guard, selector focus/value behavior, valid recipe filters, handled star errors, sync refresh, and favorite filtering for deleted recipes.
- Re-adding an existing built-in or catalog food now changes membership without first upserting bundled/catalog defaults over the account's edited nutrition or note.
- `save_food_note` was applied only to local databases after clone proof. The down migration restores the prior membership RPC and drops the new RPC/table only when the authority table is empty; it refuses rollback after an explicit note edit, preventing silent stale-note replay. Root owns final browser and cross-device proof. No production apply is claimed.

## Exact files modified by this worker

`components/ui/GlassSelect.tsx`, `components/ui/GlassSelect.module.css`, `components/ui/GlassSelect.test.tsx`, `components/ui/index.ts`, `components/EatsView.tsx`, `components/MyFoods.tsx`, `components/MyFoods.module.css`, `components/FoodSheet.tsx`, `components/AddFoodSheet.tsx`, `components/add-food/catalog-food.ts`, `components/RecipeDiscovery.tsx`, `components/RecipesSection.tsx`, `components/RecipeSheet.tsx`, `components/RecipePlanFlow.tsx`, `components/CoachChat.tsx`, `components/GoalRateField.tsx`, `components/BodyProfileFields.tsx`, `components/BodyFatSourceField.tsx`, `components/settings/TargetsSection.tsx`, `components/settings/ProfileSection.tsx`, `lib/foods/prefs-client.ts`, `lib/foods/starter-client.ts`, `lib/coach/apply-prefs.ts`, `lib/coach/apply-shared.ts`, `lib/recipe-catalog-client.ts`, `lib/recipes-client.ts`, `lib/favorites-client.ts`, `lib/store.ts`, `lib/store.test.ts`, `lib/sync/client.ts`, `lib/sync/client.test.ts`, `lib/sync/food-refs.ts`, `lib/sync/food-refs.test.ts`, `tests/cards/foods.test.tsx`, `tests/cards/recipe-access.test.tsx`, `components/FoodsTabs.test.tsx`, `tests/foods/prefs-client.test.ts`, `tests/foods/food-edits-sync.test.ts`, `tests/foods/add-food-bundled-fallback.test.tsx`, `tests/foods/food-sheet-save.test.tsx`, `tests/coach/exclusivity.test.ts`, `tests/favorites/favorites-client.test.ts`, `tests/recipes/recipes-client.test.ts`, `supabase/migrations/20261204090000_food_note_sync.sql`, `supabase/migrations/down/20261204090000_food_note_sync.down.sql`, `docs/design/KIT.md`, `docs/audit/2026-09-27-foods-annotations/note-migration-local-proof.txt`, and this report.
