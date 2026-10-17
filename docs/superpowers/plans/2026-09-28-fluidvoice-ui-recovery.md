# FluidVoice UI Recovery Implementation Plan

> **Superseded (2026-10-17):** the work this plan describes has landed on `main`. The current status of each row is in [the acceptance ledger](../../audit/2026-10-17-fluidvoice-acceptance-ledger.md); use that, not the task list below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every approved FluidVoice UI interaction on Today, Foods, Recipes, the coach composer, feedback surfaces, and the PWA update flow, then ship them through one PR and one production deployment.

**Architecture:** Keep domain writes on their existing client/server paths and add small, testable presentation controllers for gestures, date-scoped dismissal, time selection, cuisine matching, caret state, and service-worker updates. Today, Foods/Recipes, and feedback/PWA remain independently reviewable commits, while all visual state stays client-side unless an existing durable operation already owns the write.

**Tech Stack:** Next.js App Router, React 19, TypeScript, CSS modules/global design tokens, Vitest, Testing Library, Supabase-backed existing APIs, service workers, Vercel Git deployment.

**Spec:** `docs/specs/2026-09-28-fluidvoice-ui-recovery.md`

## Global Constraints

- Use one feature branch, one PR, one squash merge to `main`, and one Vercel production deployment.
- The phone remains the primary surface; every interaction must work at 320 px and follow `DESIGN.md`.
- Do not alter target authority, nutrition calculations, sync ownership, schema, production data, or existing durable write boundaries.
- Gesture-only behavior always has a visible button alternative and a target of at least 44 px.
- Every animation respects `prefers-reduced-motion`.
- Components use design tokens or semantic roles only; no raw color literals in `app/` or `components/`.
- Today presentation state is client-owned; date-scoped dismissal keys include account id, date, and card id.
- Food removal uses the existing durable neutral-membership operation; notes and history remain intact.
- Search eligibility and account rules remain hard constraints.
- The service worker never force-reloads an open tab; reload occurs only after the user chooses it and at most once per controller change.
- Instacart, Uber Eats, retailer discovery, pricing, schema changes, spoken replies, and U01 coach-ranking behavior are out of scope.
- Use red-green TDD. Run the full local suite exactly once before the PR; CI is the second full-suite gate.
- Deploy only through the merge to `main`; never run `vercel --prod`.

## Review Focus

1. A diagonal, cancelled, or short gesture must restore the prior visual state and must not perform a write; Tasks 1 and 2 add cancellation tests for every gesture controller.
2. Keyboard, screen-reader, and reduced-motion paths must reach the same result as gestures without hidden timing requirements; Tasks 1-3 add semantic-control and media-query tests.
3. Daily-card dismissal must never leak across accounts, dates, cards, SSR, or storage failures; Task 1 tests the complete key and an unavailable-storage fallback.
4. A waiting service worker must not reload automatically, loop on `controllerchange`, or discard an unsent coach draft; Task 3 tests all three cases.
5. Typo and cuisine-family matching must not bypass Avoid rules, ingredient eligibility, or server filtering; Task 2 tests matching and policy rejection together.

---

### Task 1: Restore the Today interaction model

**Files:**
- Create: `lib/today/presentation.ts`
- Create: `lib/today/presentation.test.ts`
- Create: `components/TodayMonthCalendar.tsx`
- Create: `components/TodayMonthCalendar.test.tsx`
- Create: `components/TimeWheelSheet.tsx`
- Create: `components/TimeWheelSheet.test.tsx`
- Modify: `components/MacroRings.tsx`
- Modify: `components/MacroRings.test.tsx`
- Modify: `components/TodayDayStrip.tsx`
- Modify: `components/TodayDayStrip.test.tsx`
- Modify: `components/DayNutrients.tsx`
- Create: `components/DayNutrients.test.tsx`
- Modify: `components/SlotCard.tsx`
- Modify: `components/SlotCard.test.tsx`
- Modify: `components/SlotCard.actions.test.tsx`
- Modify: `components/EditSlotSheet.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: existing `TodayDayStripProps`, `ResolvedDay`, `FoodComponent`, `SlotVariant`, `WaterDial`, `onSelect(date: string)`, `onSetCups(cups: number)`, and `EditSlotSheet` save paths.
- Produces: `calendarDragDecision(deltaY: number, velocityY: number, heldMs: number): "expand" | "collapse" | null`; `swipeDismissDecision(deltaX: number, deltaY: number): "reveal" | "dismiss" | null`; `todayDismissalKey(accountId: string, date: string, cardId: string): string`; `quarterHours(): readonly string[]`; `createTapDisambiguator(onSingle: () => void, onDouble: () => void, delayMs?: number): { click(detail: number): void; cancel(): void }`; `TodayMonthCalendarProps { date: string; onSelect(date: string): void; onClose(): void; reducedMotion?: boolean }`; `TimeWheelSheetProps { value: string; onChange(value: string): void; onClose(): void }`.

- [ ] **Step 1: Pin the Today presentation decisions with failing unit tests**

  Add tests named `calendar drag requires long hold and dominant threshold`, `upward velocity collapses`, `cancelled swipe does not dismiss`, `dismissal key includes account date and card`, `quarter hours covers 00:00 through 23:45 in 15 minute steps`, and `double tap cancels pending single tap`. Assert a hold shorter than 450 ms and diagonal movement return `null`, a completed left swipe returns `dismiss`, keyboard-style click detail `0` edits immediately, a pointer single waits 220 ms, a second click cancels edit and expands once, `cancel()` clears the timer, and `quarterHours()` has 96 unique values.

- [ ] **Step 2: Run the presentation tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run lib/today/presentation.test.ts`

  Expected: FAIL because `lib/today/presentation.ts` does not exist.

- [ ] **Step 3: Implement the pure presentation controller**

  Add the exact exports in the Interfaces block. Use fixed thresholds owned by this file, require a 450 ms hold before expansion, reject non-dominant gestures, use an upward velocity branch for collapse, use a 220 ms default only for pointer single-vs-double disambiguation, and build storage keys as `meal-companion:today-dismissed:<accountId>:<date>:<cardId>`.

- [ ] **Step 4: Prove the controller green**

  Run: `mise exec -- pnpm exec vitest run lib/today/presentation.test.ts`

  Expected: PASS.

- [ ] **Step 5: Write failing gauge, calendar, dismissal, and accessibility tests**

  In the component tests, assert carbohydrates and water render in the left gauge column, protein and fat in the right, water drag and step controls still reach the same bounded cup value, the calendar handle exposes `aria-expanded`, the month grid opens from the button and qualifying long-press drag, direct date selection calls the existing `onSelect`, Escape/upward flick closes, reduced motion omits motion classes, and DayNutrients exposes a named Clear action. Assert macro detail toggles by long hold or button while its short divider remains unchanged. Assert dismissal survives a same-date remount, returns for another date/account, and remains usable when `sessionStorage` throws.

- [ ] **Step 6: Run the Today surface tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/MacroRings.test.tsx components/TodayDayStrip.test.tsx components/TodayMonthCalendar.test.tsx components/DayNutrients.test.tsx`

  Expected: FAIL on reversed columns, absent expansion controls, and absent dismissal behavior.

- [ ] **Step 7: Implement the gauges, inline calendar, macro disclosure, and daily-card dismissal**

  Set `LEFT_DIALS` to carbohydrates then water and `RIGHT_DIALS` to protein then fat. Let `TodayDayStrip` own the calendar handle and month-grid open state, but keep all date changes routed through `onSelect`. Add an accessible disclosure around the existing “Still to eat” region with three CSS chevrons and session-only state. Add swipe reveal/full-dismiss and a visible Clear control to `DayNutrients`, using the current account id passed from `app/page.tsx`; treat storage as optional and never delete data.

- [ ] **Step 8: Prove the Today surfaces green**

  Run: `mise exec -- pnpm exec vitest run components/MacroRings.test.tsx components/TodayDayStrip.test.tsx components/TodayMonthCalendar.test.tsx components/DayNutrients.test.tsx`

  Expected: PASS.

- [ ] **Step 9: Write failing compact-card and time-wheel tests**

  Assert a collapsed `SlotCard` shows name, formatted time, calories, protein, carbohydrates, fat, semantic macro classes, and an explicit expansion button; a row click still opens edit; a double click or expansion button shows a read-only ingredient/serving table without calling mutation callbacks. Assert `TimeWheelSheet` selects only 15-minute values, wraps safely at day bounds, supports direct keyboard entry, has an opaque sheet role, and closes without saving on Escape.

- [ ] **Step 10: Run the card and time tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/SlotCard.test.tsx components/SlotCard.actions.test.tsx components/TimeWheelSheet.test.tsx`

  Expected: FAIL because expansion and `TimeWheelSheet` are absent.

- [ ] **Step 11: Implement compact meal detail and the 15-minute glass time sheet**

  Add local expansion state to `SlotCard` and use `createTapDisambiguator` for pointer clicks: keyboard clicks (`detail === 0`) edit immediately, pointer singles edit after 220 ms, and the second click cancels the pending edit before expanding. Cancel its timer on unmount. Stop propagation on the explicit expansion control, which expands immediately. Reuse resolved slot/component values for the read-only table and existing daily totals when provided. Replace the native time-choice surface in `EditSlotSheet` with `TimeWheelSheet`, while retaining direct input plus increment/decrement controls and the existing save callback.

- [ ] **Step 12: Run all Task 1 tests**

  Run: `mise exec -- pnpm exec vitest run lib/today/presentation.test.ts components/MacroRings.test.tsx components/TodayDayStrip.test.tsx components/TodayMonthCalendar.test.tsx components/DayNutrients.test.tsx components/SlotCard.test.tsx components/SlotCard.actions.test.tsx components/TimeWheelSheet.test.tsx`

  Expected: PASS with no unhandled timer, pointer, or accessibility warnings.

- [ ] **Step 13: Commit Task 1**

  ```bash
  git add app/page.tsx app/globals.css components/MacroRings.tsx components/MacroRings.test.tsx components/TodayDayStrip.tsx components/TodayDayStrip.test.tsx components/TodayMonthCalendar.tsx components/TodayMonthCalendar.test.tsx components/DayNutrients.tsx components/DayNutrients.test.tsx components/SlotCard.tsx components/SlotCard.test.tsx components/SlotCard.actions.test.tsx components/EditSlotSheet.tsx components/TimeWheelSheet.tsx components/TimeWheelSheet.test.tsx lib/today/presentation.ts lib/today/presentation.test.ts
  git commit -m "feat: restore today interactions"
  ```

### Task 2: Complete Foods, Avoids, and recipe interactions

**Files:**
- Create: `lib/recipe-catalog/cuisine.ts`
- Create: `lib/recipe-catalog/cuisine.test.ts`
- Modify: `lib/recipe-catalog/repository.ts`
- Modify: `tests/recipe-catalog/search-http.test.ts`
- Modify: `components/MyFoods.tsx`
- Modify: `components/MyFoods.module.css`
- Create: `components/MyFoods.test.tsx`
- Modify: `components/AddFoodSheet.tsx`
- Modify: `lib/catalog-client.ts`
- Modify: `lib/catalog-client.test.ts`
- Modify: `lib/search/query.ts`
- Modify: `lib/search/query.test.ts`
- Modify: `lib/server/catalog.ts`
- Modify: `lib/server/catalog.test.ts`
- Modify: `components/RecipeDiscovery.tsx`
- Create: `components/RecipeDiscovery.test.tsx`
- Modify: `components/RecipeDraftList.tsx`
- Create: `components/RecipeDraftList.test.tsx`
- Modify: `components/RecipeSheet.tsx`
- Modify: `tests/recipes/recipe-sheet.test.tsx`
- Modify: `tests/recipes/recipe-sheet-offline.test.tsx`
- Modify: `components/AvoidImpact.tsx`
- Modify: `components/AvoidImpact.test.ts`
- Create: `components/AvoidImpact.ui.test.tsx`
- Modify: `components/AvoidRules.tsx`
- Modify: `components/AvoidRules.test.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: existing `setFoodMembership`, `RecipeSearch`, `searchCatalog`, `RecipeIngredientPicker`, affected-meal instance ids, `ActionFeedback`, and constraint-save paths.
- Produces: `normalizeCuisineFamily(value: string): string`; `cuisineSearchPattern(value: string): string`; `foodDiscoveryTerms(value: string): readonly string[]` containing the normalized raw phrase plus only existing catalog synonym/policy-category aliases; `foodRowSwipeDecision(deltaX: number, deltaY: number): "reveal" | "remove" | null`; `AskSashaPayload { question: string; affectedIds: string[] }` with affected ids deduplicated and capped at the existing bounded request limit.

- [ ] **Step 1: Write failing cuisine and HTTP search tests**

  Assert `normalizeCuisineFamily(" Italian-inspired ") === "italian"`, `cuisineSearchPattern("Italian") === "%italian%"`, an Italian request can return an eligible Italian-inspired recipe, a Chinese request with no eligible rows returns an empty result rather than `cannot_match_any_requests`, and a matching recipe containing an Avoid ingredient remains excluded. In the catalog tests, assert `foodDiscoveryTerms` preserves an ordinary ingredient, routes a misspelling through the existing trigram/synonym search, includes an existing policy-category alias for a cuisine/category request, deduplicates terms, and still returns the server policy mark with blocked rows.

- [ ] **Step 2: Run recipe search tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run lib/recipe-catalog/cuisine.test.ts tests/recipe-catalog/search-http.test.ts lib/search/query.test.ts lib/catalog-client.test.ts lib/server/catalog.test.ts`

  Expected: FAIL because cuisine normalization is absent and repository matching is exact.

- [ ] **Step 3: Implement normalized cuisine-family matching at the repository boundary**

  Add the cuisine exports and `foodDiscoveryTerms` from the Interfaces block. Normalize dash/space variants and the `-inspired` suffix without broad synonym invention. Build food discovery only from the existing synonym vocabulary and policy-category labels; do not add a new database table or migrate production data. Have the catalog client issue the bounded, deduplicated terms through its existing cancellation/deadline controller and merge rows by stable key; keep server policy results authoritative. Change the recipe repository cuisine predicate to a contains pattern while preserving all existing account-policy and ingredient-eligibility filters. Map an eligible empty result to the normal empty collection; preserve genuine request errors.

- [ ] **Step 4: Prove recipe search green**

  Run: `mise exec -- pnpm exec vitest run lib/recipe-catalog/cuisine.test.ts tests/recipe-catalog/search-http.test.ts lib/search/query.test.ts lib/catalog-client.test.ts lib/server/catalog.test.ts`

  Expected: PASS.

- [ ] **Step 5: Write failing food-row and category-footer tests**

  Assert row click opens `FoodSheet`; a short or vertical swipe does not write; a partial left swipe reveals Remove; a full left swipe calls the existing neutral-membership operation once; Other foods get the same behavior; each rendered category card ends with a centered Add row; and Avoids renders the user's avoid list before rules/conditions.

- [ ] **Step 6: Run the Foods tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/MyFoods.test.tsx components/AvoidRules.test.tsx`

  Expected: FAIL on missing swipe state, missing uniform Add rows, or hierarchy order.

- [ ] **Step 7: Implement food-row edit/swipe and category affordances**

  Add `foodRowSwipeDecision` beside the row code and route confirmed removal through the current durable neutral-membership callback. Share one category-card footer component across role groups and Other. Preserve notes, truncated-family notices, optimistic rollback, and current edit sheets. Reorder only the Avoids presentation hierarchy; do not change rule persistence.

- [ ] **Step 8: Prove Foods green**

  Run: `mise exec -- pnpm exec vitest run components/MyFoods.test.tsx components/AvoidRules.test.tsx`

  Expected: PASS.

- [ ] **Step 9: Write failing recipe-layout and ingredient-row tests**

  Assert search is the first Recipes control, the icon is inside the field at the right, Enter and click call the same search function once, cuisine/minutes/effort share one phone-width row, empty results show clear copy plus Reset filters, and the last draft ingredient row reads “Add ingredient” and opens the existing picker without mutating the draft. Extend the existing recipe-sheet tests to prove New recipe, edit/version save, delete confirmation, and offline draft recovery still work.

- [ ] **Step 10: Run recipe UI tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/RecipeDiscovery.test.tsx components/RecipeDraftList.test.tsx tests/recipes/recipe-sheet.test.tsx tests/recipes/recipe-sheet-offline.test.tsx`

  Expected: FAIL on layout semantics, empty-state reset, or missing add row.

- [ ] **Step 11: Implement recipe discovery and ingredient affordances**

  Use one `submitSearch()` path for form submit and icon click. Keep New recipe and existing saved-recipe CRUD untouched. Add an `onAddIngredient(): void` prop to `RecipeDraftList`; render the row-shaped blank affordance after current items and let `RecipeSheet` switch to the existing `RecipeIngredientPicker`.

- [ ] **Step 12: Prove recipe UI green**

  Run: `mise exec -- pnpm exec vitest run components/RecipeDiscovery.test.tsx components/RecipeDraftList.test.tsx tests/recipes/recipe-sheet.test.tsx tests/recipes/recipe-sheet-offline.test.tsx tests/recipe-catalog/search-http.test.ts`

  Expected: PASS.

- [ ] **Step 13: Write failing Ask Sasha and Conditions-isolation tests**

  Assert the affected count opens the matching instance list with edit/remove/remix actions, free text plus deduplicated bounded affected ids reach the existing coach path, blank text is not sent, fixed shortcuts still work, an affected eaten item retains its protected action set, saving a custom Avoid rule cannot activate Conditions success state, and saving Conditions can.

- [ ] **Step 14: Run affected-meal and Conditions tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/AvoidImpact.test.ts components/AvoidImpact.ui.test.tsx components/AvoidRules.test.tsx`

  Expected: FAIL on missing free text or shared feedback state.

- [ ] **Step 15: Implement bounded free-text Ask Sasha and isolated Conditions feedback**

  Add a labeled textarea/input to `AvoidImpact`; preserve the shortcut controls and use the existing coach/navigation boundary. Give Conditions its own action-feedback key and lifecycle, separate from custom rules. Do not weaken eaten-history protection or remix eligibility.

- [ ] **Step 16: Run all Task 2 tests**

  Run: `mise exec -- pnpm exec vitest run lib/recipe-catalog/cuisine.test.ts lib/search/query.test.ts lib/catalog-client.test.ts lib/server/catalog.test.ts components/MyFoods.test.tsx components/RecipeDiscovery.test.tsx components/RecipeDraftList.test.tsx components/AvoidImpact.test.ts components/AvoidImpact.ui.test.tsx components/AvoidRules.test.tsx tests/recipes/recipe-sheet.test.tsx tests/recipes/recipe-sheet-offline.test.tsx tests/recipe-catalog/search-http.test.ts`

  Expected: PASS.

- [ ] **Step 17: Commit Task 2**

  ```bash
  git add app/globals.css components/AddFoodSheet.tsx components/MyFoods.tsx components/MyFoods.module.css components/MyFoods.test.tsx components/RecipeDiscovery.tsx components/RecipeDiscovery.test.tsx components/RecipeDraftList.tsx components/RecipeDraftList.test.tsx components/RecipeSheet.tsx components/AvoidImpact.tsx components/AvoidImpact.test.ts components/AvoidImpact.ui.test.tsx components/AvoidRules.tsx components/AvoidRules.test.tsx lib/catalog-client.ts lib/catalog-client.test.ts lib/search/query.ts lib/search/query.test.ts lib/server/catalog.ts lib/server/catalog.test.ts lib/recipe-catalog/cuisine.ts lib/recipe-catalog/cuisine.test.ts lib/recipe-catalog/repository.ts tests/recipes/recipe-sheet.test.tsx tests/recipes/recipe-sheet-offline.test.tsx tests/recipe-catalog/search-http.test.ts
  git commit -m "fix: complete foods and recipe interactions"
  ```

### Task 3: Finish composer state, action feedback, and PWA update safety

**Files:**
- Modify: `components/coach/use-composer-input.ts`
- Create: `components/coach/use-composer-input.test.tsx`
- Modify: `components/coach/Composer.tsx`
- Modify: `lib/haptics.ts`
- Modify: `lib/haptics.test.ts`
- Modify: `components/ServiceWorkerRegistrar.tsx`
- Create: `components/ServiceWorkerRegistrar.test.tsx`
- Modify: `public/sw.js`
- Modify: `components/LogFoodSheet.tsx`
- Modify: `components/LoggedExtras.tsx`
- Modify: `components/LoggedExtras.test.tsx`
- Modify: `components/NoteSheet.tsx`
- Modify: `components/NoteSheet.test.tsx`
- Modify: `components/FoodSheet.tsx`
- Modify: `components/CaptureConfirm.tsx`
- Create: `components/CaptureConfirm.test.tsx`
- Modify: `components/ScanConfirmSheet.tsx`
- Create: `components/ScanConfirmSheet.test.tsx`
- Modify: `components/settings/ProfileSection.tsx`
- Modify: `components/settings/TargetsSection.tsx`
- Modify: `components/Onboarding/OnboardingFlow.tsx`
- Modify: `components/Onboarding/FoodsStep.test.tsx`
- Modify: `components/SlotCard.tsx`
- Create: `tests/design/action-feedback-rollout.test.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: existing `ActionFeedback`, `commitSuccessHaptic`, composer `onSend`, durable logging/food/settings/onboarding/meal writes, and service-worker registration.
- Produces: composer state `caretAtEnd: boolean`; `canShowRecord(draft: string, selectionStart: number | null, selectionEnd: number | null): boolean`; `UpdatePrompt` state driven by `ServiceWorkerRegistration.waiting`; worker message `{ type: "SKIP_WAITING" }`; module-scoped `controllerReloaded` loop guard.

- [ ] **Step 1: Write failing composer-caret tests**

  Assert a non-empty draft with a collapsed caret at its end shows Record beside Send; a caret or selection inside the draft hides Record but keeps Send; clicks/selections never submit; Enter submits once when not composing; Shift+Enter and IME composition do not submit; existing stop/review/send and retained-transcript tests remain green.

- [ ] **Step 2: Run composer tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/coach/use-composer-input.test.tsx tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx`

  Expected: FAIL only on the new caret-at-end rule.

- [ ] **Step 3: Implement explicit caret state without changing the recording controller**

  Export `canShowRecord` and update caret state from `select`, `click`, `keyup`, and input changes. Derive control visibility from position rather than the current broad `editing` flag. Keep submission exclusively in the form/keyboard send paths.

- [ ] **Step 4: Prove composer green**

  Run: `mise exec -- pnpm exec vitest run components/coach/use-composer-input.test.tsx tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx`

  Expected: PASS.

- [ ] **Step 5: Write failing haptic and feedback-contract tests**

  Assert the success vibration rises to its strongest pulse early, decays after the peak, and stays near a two-second total envelope. For logging, eaten toggle, Favorites membership, notes, food edits, barcode save, capture save, Settings, onboarding, and meal edits, assert success triggers `ActionFeedback`, failure renders the shared alert and never calls the success haptic, pending/blocker/change roles map to yellow/red/violet semantics, and safe reversible writes expose Undo. Add a source-contract test for those named surfaces that requires enabled buttons to use the shared `tap` treatment and persistent single-select controls to expose `aria-pressed`, `aria-selected`, or native checked state.

- [ ] **Step 6: Run feedback tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run lib/haptics.test.ts components/LoggedExtras.test.tsx components/NoteSheet.test.tsx components/CaptureConfirm.test.tsx components/ScanConfirmSheet.test.tsx components/Onboarding/FoodsStep.test.tsx components/SlotCard.actions.test.tsx components/ui/ActionFeedback.test.tsx tests/design/action-feedback-rollout.test.ts`

  Expected: FAIL on the haptic envelope and any uncovered write surface.

- [ ] **Step 7: Complete the shared feedback rollout**

  Change only `COMMIT_SUCCESS_PATTERN` for the approved rise-then-decay envelope. Wrap existing write completion/error/undo states with the shared feedback component rather than adding parallel mutation logic. Use stable action keys so unrelated writes cannot trigger another surface. Preserve user input on failure.

- [ ] **Step 8: Prove feedback green**

  Run: `mise exec -- pnpm exec vitest run lib/haptics.test.ts components/LoggedExtras.test.tsx components/NoteSheet.test.tsx components/CaptureConfirm.test.tsx components/ScanConfirmSheet.test.tsx components/Onboarding/FoodsStep.test.tsx components/SlotCard.actions.test.tsx components/ui/ActionFeedback.test.tsx tests/design/action-feedback-rollout.test.ts`

  Expected: PASS.

- [ ] **Step 9: Write failing service-worker update tests**

  Mock `navigator.serviceWorker.register` and assert no notice without a waiting worker; a waiting worker shows persistent “Update available” plus Reload; dismissal is session-only; Reload posts `{ type: "SKIP_WAITING" }` but does not immediately call `location.reload`; the first subsequent `controllerchange` reloads once; repeated events do not loop; registration/update errors are non-blocking; and the coach draft remains unchanged before the user selects Reload.

- [ ] **Step 10: Run update-flow tests and confirm the red state**

  Run: `mise exec -- pnpm exec vitest run components/ServiceWorkerRegistrar.test.tsx`

  Expected: FAIL because the registrar currently renders no update UI.

- [ ] **Step 11: Implement the opt-in update prompt and worker activation message**

  Track `registration.waiting`, `updatefound`, and installing worker state in `ServiceWorkerRegistrar`. Render a token-based fixed notice with Reload and Dismiss. On Reload, message only the waiting worker. In `public/sw.js`, handle only `SKIP_WAITING` by calling `self.skipWaiting()`. Guard `controllerchange` with module-scoped state and remove listeners on unmount.

- [ ] **Step 12: Run all Task 3 tests**

  Run: `mise exec -- pnpm exec vitest run components/coach/use-composer-input.test.tsx tests/coach/tap-dictation.test.ts tests/coach/composer/tap-control.test.tsx lib/haptics.test.ts components/LoggedExtras.test.tsx components/NoteSheet.test.tsx components/CaptureConfirm.test.tsx components/ScanConfirmSheet.test.tsx components/Onboarding/FoodsStep.test.tsx components/SlotCard.actions.test.tsx components/ui/ActionFeedback.test.tsx components/ServiceWorkerRegistrar.test.tsx tests/design/action-feedback-rollout.test.ts`

  Expected: PASS.

- [ ] **Step 13: Commit Task 3**

  ```bash
  git add app/page.tsx app/globals.css components/coach/use-composer-input.ts components/coach/use-composer-input.test.tsx components/coach/Composer.tsx components/ServiceWorkerRegistrar.tsx components/ServiceWorkerRegistrar.test.tsx components/LogFoodSheet.tsx components/LoggedExtras.tsx components/LoggedExtras.test.tsx components/NoteSheet.tsx components/NoteSheet.test.tsx components/FoodSheet.tsx components/CaptureConfirm.tsx components/CaptureConfirm.test.tsx components/ScanConfirmSheet.tsx components/ScanConfirmSheet.test.tsx components/settings/ProfileSection.tsx components/settings/TargetsSection.tsx components/Onboarding/OnboardingFlow.tsx components/Onboarding/FoodsStep.test.tsx components/SlotCard.tsx lib/haptics.ts lib/haptics.test.ts public/sw.js tests/design/action-feedback-rollout.test.ts
  git commit -m "feat: finish action feedback and update prompt"
  ```

### Task 4: Verify, review, land, and prove the single production deployment

**Files:**
- Create outside the repository after deployment: `/Users/zero-suminc./Inbox/notes/meal-companion-ui-recovery-production-2026-09-28.md`
- Do not create a post-merge repository commit; the production receipt must not trigger a second deployment.

**Interfaces:**
- Consumes: the three implementation commits, repo CI, `~/bin/zs-land`, Vercel Git integration, approved pilot account, and production URL.
- Produces: one squash commit on `main`, one matching Vercel production SHA, and an external acceptance receipt separating source, local-render, CI, and production proof.

- [ ] **Step 1: Run the complete focused regression set**

  Run the Task 1-3 test files together with existing voice, recipe, Foods, and action-feedback focused suites.

  Expected: PASS with no skipped new acceptance test and no leaked timers/listeners.

- [ ] **Step 2: Run static checks**

  Run: `mise exec -- pnpm lint`

  Expected: exit 0 with zero warnings.

  Run: `mise exec -- pnpm exec tsc --noEmit`

  Expected: exit 0.

- [ ] **Step 3: Run the full local suite exactly once**

  Run: `mise exec -- pnpm test`

  Expected: every suite passes. Do not repeat the full suite; fix any failure with its focused test only.

- [ ] **Step 4: Build the production bundle**

  Run: `mise exec -- pnpm build`

  Expected: exit 0, including dietary-profile and AI-runtime trace checks.

- [ ] **Step 5: Capture local rendered evidence**

  Start the pinned app on an unused local port and use the approved pilot account. At 320, 390, 430, and 1024 px, verify Today expanded/collapsed/calendar/time states, Foods edit/swipe/Add/search, recipe empty/reset and ingredient-add states, composer caret states, feedback success/failure/Undo, and the update prompt. Exercise both gesture and visible-button alternatives and record screenshots under a temporary evidence directory outside the repository.

- [ ] **Step 6: Perform the whole-branch review**

  Review `origin/main...HEAD` against the spec and this plan, prioritizing the five Review Focus conditions, domain-boundary drift, raw colors, listener cleanup, accidental writes, and accessibility. Resolve each actionable finding with a focused failing test and a new commit; do not amend an implementation commit after review begins.

- [ ] **Step 7: Push, open the PR, and attach it to the task**

  Run `~/bin/zs-land` from `feat/ui-recovery`. Confirm it pushes the branch, opens the PR, and reports the gated CI result. Attach the resulting PR URL with the Codex artifact tool.

  Expected: one PR with green required checks. If `zs-land` stops at the client-repo PR boundary, continue to merge only because the user explicitly authorized this one release.

- [ ] **Step 8: Squash-merge and verify Git state**

  Confirm the PR squash-merges to `main`, fetch, and record the exact remote `main` SHA. Verify there are no open PRs created by this work and no unpushed branch commits.

- [ ] **Step 9: Wait for the exact Vercel deployment**

  Use the existing deployment/readiness path to wait until production reports the exact merged `main` SHA. Do not run `vercel --prod` and do not accept a successful deployment for an older SHA.

- [ ] **Step 10: Perform the signed-in production walkthrough**

  With the approved pilot account, repeat the critical 390 px Today, Foods/Recipes, composer, feedback, and update-notice paths. Distinguish unavailable update-worker simulation from production-proven behavior. Record pass/fail, URL, timestamp, merged SHA, deployed SHA, and screenshots in `/Users/zero-suminc./Inbox/notes/meal-companion-ui-recovery-production-2026-09-28.md`.

- [ ] **Step 11: Audit stale state only after release proof**

  Refresh local/remote branches, active worktrees, running app processes, open PRs, and deployment state. Compare each stale candidate with the merged squash commit before any cleanup. Archive managed worktrees with the Codex worktree tool and delete only branches whose work is provably represented on `main`; preserve the one ongoing session named by the user.

- [ ] **Step 12: Report completion with exact receipts**

  Report the PR URL, squash SHA, matching Vercel deployment SHA/URL, check results, production acceptance result, preserved ongoing session, and any cleanup deferred because ancestry or ownership was uncertain. Do not label source-only or local-render proof as production proof.
