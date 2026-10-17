# FluidVoice UI recovery: acceptance ledger (W152)

Date: 2026-10-17. Main at `5a1b4c6`. Spec: `docs/specs/2026-09-28-fluidvoice-ui-recovery.md`.

**Every row below is "source only".** No row has production proof: no signed-in production walkthrough was run, and no screenshots exist at 320, 390, 430 or 1024 px. Both need the pilot account and Devin's sign-in (ZS Vault Fill), so they are owner steps (see the end). "Source only" means a source anchor and a test file exist on main; it does not mean the behaviour was exercised in a browser here. The anchors were found by symbol search, not by reading each component end to end; a test file named below was confirmed to exist, but not run or read for the specific case.

A row marked **not located** had no matching symbol in a search of `components/`, `lib/` and `app/`. That is a gap in this ledger, not proof the behaviour is missing: it needs a person to check the UI.

## Rows the spec describes

| Row | Spec item | Source anchor on main | Test | Status |
|---|---|---|---|---|
| T02 | Gauge layout: carbs above water, protein above fat | `components/MacroRings.tsx:40` (carbs), `:47` (fat) | `components/MacroRings.test.tsx` | source only |
| T03 | Water hold-and-drag plus step controls | `components/today/WaterTile.tsx:99` (`createWaterScrub`), `lib/today/water-scrub.ts:71`, `lib/today/water-gesture.ts:9` | `lib/today/water-gesture.test.ts`, `tests/today/water-and-weight.test.ts` | source only |
| T05 | Calendar handle between day strip and macros, `aria-expanded` button | `components/TodayDayStrip.tsx:272` | `components/TodayDayStrip.test.tsx` | source only |
| T06 | Inline month grid, date select, close, reduced motion | `components/TodayMonthCalendar.tsx:25` (select `:12`, `reducedMotion` `:15`); double-tap toggle `components/TodayDayStrip.tsx:218`. A long-press-then-drag gesture was not found by symbol search | `components/TodayMonthCalendar.test.tsx` | source only; long-press drag **not located** |
| T07 | Long-press "Still to eat" collapses macro detail, chevrons, button path | `components/DayNutrients.tsx:125` (pointer down), `:188` (`aria-expanded`). Session-only persistence not located | `components/DayNutrients.test.tsx` | source only |
| T04 | Daily info card: swipe to Clear, per account, date and card | `lib/today/presentation.ts:38` (`swipeDismissDecision`), `:47` (`todayDismissalKey`). Storage fallback not located | `lib/today/presentation.test.ts` | source only |
| T08, U03 | Compact meal card, double tap or affordance expands read-only detail | `components/SlotCard.tsx:210` (`expanded`), `components/SlotCardDetail.tsx`. Double-tap handler and detail table **not located** | `components/SlotCard.test.tsx`, `SlotCard.v2.test.tsx`, `SlotCard.v3.test.tsx`, `SlotCard.actions.test.tsx` | source only; double tap **not located** |
| U05 | 15-minute time wheel sheet, keyboard entry | `components/TimeWheelSheet.tsx:57`, `:98` (keyboard); used at `components/EditSlotSheet.tsx:6` | `components/TimeWheelSheet.test.tsx` | source only |
| A04, A05, T09 | Food row tap edits; left swipe Remove; Add row in every card | swipe or remove handling in `components/MyFoods.tsx` and `MyFoods.module.css` (the only matches for "swipe"); `components/MyFoods.list.tsx:10` (`ListAdd`) | `components/MyFoods.test.tsx` | source only; Remove-on-swipe and role-group coverage not confirmed |
| A03, A06 | Recipe search first, icon inside the field, one submit path | `components/RecipeDiscovery.tsx:125` (`onSubmit`) | `components/RecipeDiscovery.test.tsx` | source only |
| A07, U02, U04 | Compact filter row; ingredient editor ends with an "Add ingredient" row | `components/RecipeSheet.tsx:31` (comment names the Add ingredient row; the label string was not found in a text search) | `components/RecipeDiscovery.test.tsx` | source only; the row itself **not located** |
| A10, X01 | Add-to-Avoid search by alias, typo, cuisine; cuisine family matching; explicit empty state with reset | `lib/recipe-catalog/cuisine.ts:11` (`normalizeCuisineFamily`); `components/RecipeDiscovery.tsx:117` (`resetFilters`); `components/AvoidImpact.tsx:425` ("Food or cuisine to check"). `cannot_match_any_requests` appears nowhere in `lib/` or `app/` | `lib/recipe-catalog/cuisine.test.ts`, `components/RecipeDiscovery.test.tsx` | source only |
| A09 | Affected meals: free-text Ask Sasha with bounded ids | `components/AvoidImpact.tsx:43` (`AskSashaPayload`, `affectedIds`), `:35` (bound) | no AvoidImpact test file found | source only, **no dedicated test located** |
| A11 | Conditions save owns its feedback; rising-then-decaying haptic | `components/AvoidRules.tsx:104` (own feedback key); `lib/haptics.ts:11` and `:17` (`COMMIT_SUCCESS_PATTERN`, `commitSuccessHaptic`) | `components/AvoidRules.test.tsx`, `lib/haptics.test.ts` | source only |
| V01-V06 | Composer: Record, Stop, Review, Send; Enter and IME rules; caret state | `components/coach/use-composer-input.ts:10` (`canShowRecord` takes the selection); mic components `components/CoachMic.tsx`, `components/DictateMic.tsx` | `components/coach/use-composer-input.test.tsx`, `components/DictateMic.test.tsx` | source only; per-row split among V01-V06 not made |
| F01-F09 | Pressed state, selected state, success glow and haptic, red failure toast, pending, changed, Undo | `components/ui/ActionFeedback.tsx:8` (phases `idle`, `pending`, `success`, `changed`, `failed`), `:131` (Undo); pressed rule `app/globals.css:1159`; `lib/haptics.ts` | no ActionFeedback test file found | source only; per-row split and rollout surfaces **not checked** |
| (no row id) Update availability | Persistent "Update available" with Reload; no forced reload; one reload per controller change | `components/ServiceWorkerRegistrar.tsx:20` (per-session dismiss), `:100` (`controllerchange`) | `components/ServiceWorkerRegistrar.test.tsx`, `tests/sw/` | source only |

## Rows with no description in the spec

The spec names A01, A02, A08, A12-A15, T01, T10 and V07 only as part of the "42 rows" count; their text lives in the recovered FluidVoice corpus, which is not in this repository. They cannot be mapped to code from the spec, so they are listed as **unmapped**. U01 is out of scope in the spec (coach ranking).

## Other criteria from the spec's completion list

| Criterion | Status |
|---|---|
| Rendered evidence at 320, 390, 430 and 1024 px | none exists; owner step |
| Production deployment verified at the merged SHA, signed-in walkthrough on the pilot account | none recorded; owner step |
| Lint, typecheck, build and CI | run on every merged PR; this ledger is docs only |

## Live mic paths

Voice capture through Gemini Live is retired. Only the two live paths apply: `components/CoachMic.tsx` (tap to record on the coach composer) and `components/DictateMic.tsx` (text capture box). Both were left as source only.

## Stale branches and worktrees (for W132)

On 2026-10-17, `git branch -r` on origin lists no branch other than `main` and the active `claude/` thread branches, and `git worktree list` shows only the primary checkout. No FluidVoice-era branch or worktree is left in this clone. Local branches and worktrees on the Mac are not visible from here; the Mac session should check them against `docs/handoffs/2026-10-08-stopping-point.md`.

## Owner steps to turn "source only" into production proof

1. Sign in to the production app with the pilot account and walk Today, Foods, Recipes, the composer and the update notice at 320, 390, 430 and 1024 px.
2. Save the screenshots and the deployed SHA next to this ledger.
3. Edit the Status column of each row you verified to "production proof".
