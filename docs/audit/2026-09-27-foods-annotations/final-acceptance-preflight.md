# A01–A15 acceptance preflight

Read-only evidence audit on 2026-09-27/28. **YES** below means the recorded
local source, test and browser evidence covers the item well enough to put a
binary yes to the independent reviewers. **PARTIAL** means a named criterion
still lacks proof; **NO** means a required capability is absent or the core
journey is unproved. These are evidence verdicts, **not final acceptance**:
`acceptance.md` also requires two independent item-level yes/no verdicts and
root's final audit/CI gate. Jev and the release decision remain with root.
All browser and SQL writes cited here used synthetic local accounts. The
custom-rule and food-note migrations were applied to local databases only.

| Item | Evidence verdict | Best evidence | Gap before a final yes |
| --- | --- | --- | --- |
| A01 Diet style | **PARTIAL** | [Live](root-live-evidence.md): review, cancel, confirm Vegetarian, reload, and restore neutral. [Rules](rules-report.md) and `tests/foods/diet-client.test.ts` cover validated account-bound save. | No recorded suggestion comparison after the change or authenticated second-account check of diet flags. |
| A02 Effort selector | **PARTIAL** | [Live](root-live-evidence.md): opened list; ArrowDown/Enter changed value and restored focus, Escape closed it, width 390/390. `components/ui/GlassSelect.test.tsx` covers click, labels, disabled states and dialog portal; [visual](gemini-visual-review-final.md) checked the pictured popup. | No physical touch or assistive-screen-reader pass. Code/test ARIA checks are useful but do not measure that interaction. |
| A03 Compact filters | **YES, local** | [Live](root-live-evidence.md), [recipe screenshot](recipes-results-final-mobile.png): cuisine on one row, minutes and effort together below at 390 px, no horizontal overflow. `components/RecipeDiscovery.tsx` uses 44 px controls. | Independent item verdicts remain. |
| A04 Food edit/remove | **PARTIAL** | [Live](root-live-evidence.md): note saved, reloaded, reopened and cleared; [UI report](foods-ui-report.md) covers group/nutrition revision checks and left-swipe plus accessible Remove. [Note SQL](note-migration-local-proof.txt) proves stale-note and cross-owner guards locally. | No final live swipe, category/nutrition reload across devices, or end-to-end remove/history check. |
| A05 Card Add footers | **PARTIAL** | [UI report](foods-ui-report.md) and `components/MyFoods.tsx` place Add in protein, carb, fat and Other, including empty cards; [live](root-live-evidence.md) used Add Protein successfully. | The other three categories and empty-card landing were not exercised in the browser. |
| A06 Recipe placement/search | **PARTIAL** | [Live](root-live-evidence.md), [search result image](recipes-results-final-mobile.png): discovery inside Recipes after usual foods, icon at input right, search returned recipes. `components/RecipeDiscovery.tsx` has a labelled submit button and form submit path. | No recorded keyboard Enter submission or screen-reader run on that search control. |
| A07 Recipe CRUD | **YES, local** | [Live](root-live-evidence.md): distinct New recipe, create/version 1, edit/version 2, favorite, confirm soft-delete and reload empty. [UI report](foods-ui-report.md), `tests/recipes/recipes-client.test.ts` and catalog immutability tests cover ownership/revision behavior. | Independent item verdicts and final integration gate remain. |
| A08 Custom rules | **PARTIAL** | [Live](root-live-evidence.md): Guidance garlic added, edited to Ingredient, reloaded, removed/reloaded. [Owner SQL](custom-rules-owner-db-proof.txt), [grants](migration-final-grants-proof.txt), [rules](rules-report.md), and `tests/recipe-catalog/catalog-ingredient-policy.test.ts` cover persistence, owner isolation and fail-closed ingredient evidence. | No end-to-end matrix proving ingredient/cuisine exclusions consistently in every recommendation, remix and acceptance path. Missing composite ingredients correctly stay unknown. |
| A09 Conditions feedback | **PARTIAL** | [Live](root-live-evidence.md) and [toast screenshot](conditions-toast-clear-mobile.png): explicit Save and Enter, reload, failure kept draft, success feedback cleared assistant FAB. [Rules](rules-report.md) and haptic tests cover visual fallback/reduced-motion code. | The approximate two-second physical haptic envelope and behavior on a supported device were not measured. |
| A10 Avoid search | **PARTIAL** | [Live](root-live-evidence.md): bean fallback returned several built-in beans; Black beans added, reloaded, moved to Avoid. [UI report](foods-ui-report.md) and `tests/foods/add-food-bundled-fallback.test.tsx` cover the zero-result cause and first Avoid membership target. | No representative alias/partial/typo browser corpus, suggestion response after selection, or authenticated second-user check. |
| A11 Affected plans | **NO, full journey** | [Live](root-live-evidence.md): impact POST fixed from 400 to 200; ambiguous saved slots show honest `0+` lower bound. [Rules](rules-report.md) and `tests/foods/avoid-impact-route.test.ts` cover owner-scoped scan and eaten exclusion. [History DB](shopping-history-local-proof.md) separately proves consumed-state CAS race. | No browser/database proof of exact affected instances, save-then-scan, edit/remove/remix and swipe outcomes, targeted Ask Sasha quality, or inline settings conflict resolution. Current opaque slots cannot support an exact count; the two history tests do not form an atomic Avoid/consume race. |
| A12 Location/prices | **NO, provider dependency** | [Manual shopping browser](root-live-evidence.md) saved without budget/location/currency. [Shopping report](shopping-report.md) and `tests/shopping/ui.test.tsx` cover optional coarse location on direct tap and account-keyed device store notes. | No approved live store-search/product-price provider, licensed data, SKU mapping, freshness or usable credential contract. Nearby store selection and real prices are unavailable by design; no quote or exact bill was invented. |
| A13 Dropdown consistency | **PARTIAL** | [UI report](foods-ui-report.md); current source uses `GlassSelect` in recipe, plan, shopping, settings, body and food selectors. [Live](root-live-evidence.md) covers one mobile effort selector; component tests cover keyboard, disabled and dialog portal. | No app-wide browser/assistive audit of every migrated selector's touch, focus, clipping and preserved value. |
| A14 Shared selector | **YES, local** | [UI report](foods-ui-report.md), `docs/design/KIT.md`, `components/ui/index.ts`, `components/ui/GlassSelect.test.tsx`: reusable documented export and real consumers, with selected/disabled/keyboard/portal tests. | Independent item verdicts remain; A13's broader adoption QA is separate. |
| A15 Shopping lists | **PARTIAL** | [Manual browser](root-live-evidence.md), [receipt](shopping-manual-browser.json): blank save, edit, bought/note, reload/reopen. [Real DB](shopping-history-local-proof.md): generated accept/replan preserved checked windows, notes, checked manual line and canonical ingredient pin; second owner saw no lines. [Shopping report](shopping-report.md) covers recoverable errors. | Exact reported population error was not captured, and no generated-plan save/reopen/replan **browser** journey was recorded. Database success does not prove that UI flow. |

The cross-cutting recipe-evidence issue is **PARTIAL**. The reported
American/15-minute/Any query was reproduced, then returned useful recipes in
the local browser without repeated generic restriction errors
([live](root-live-evidence.md), [result image](recipes-results-final-mobile.png)).
Stable USDA source-ID repair appended 12 current pilot revisions, mapped
62/62 current ingredients and left sealed history unchanged; a local facet
warm used the existing lifecycle ([repair proof](recipe-repair-local-proof.md)).
Its 29 public-food fixture lacks complete ingredient labels, so prepared
composites remain unverified rather than being called allergen-free. The typed
rule-review link exists in `components/RecipeDiscovery.tsx`, but no live
rule-review-required search error was exercised. Production repair, warm and
migration apply are not evidenced here.

The single combined full suite initially had 46 failures/22 files. Saved
targeted repairs account for those buckets ([coach](full-suite-coach-repair.md),
[integration](full-suite-integration-repair.md), [UI](foods-ui-report.md),
[rules](rules-report.md)); there is no second full-suite green claim. Root
still owns final build/CI, the two required independent verdicts, and release.
