# Backend → UI hand-offs (2026-10-05)

These backend changes are on `main`. Each item says what the UI lane can now show. The backend
lane does not edit `components/` or `app/**/page.tsx`. Mark an item done here when it is wired.

## t17: log edge cases (#407)

1. **Wired** (components/LoggedExtras.tsx `NOT_SAVED_LINE`/`LoggedExtraCard`, app/page.tsx
   `retryLogged`): a deferred entry was already drawn pending by `lib/log/today-state.ts`; a
   refused one (`entry.notSaved`) now gets its own card line and retry, routed to
   `retryDeferred` rather than the plain unsaved/lost path.
2. **Wired** (components/LoggedExtras.tsx `macroLine`, components/LogFoodSheet.tsx portion view,
   components/NutrientBreakdown.tsx): an unknown-mass entry shows its count and unit ("1 ×
   portion label"), never "0 g", with the shared partial note (`lib/nutrition-display.ts`
   `PARTIAL_NOTE`).
3. **Wired** (components/LogFoodSheet.picks.ts `sheetCard`): carries `massUnknown` from
   `sheetPreview` onto the card it returns.

## O4a: recipe search ranks and never filters (#415)

4. **Wired** (components/RecipeDiscovery.tsx, components/coach/blocks/recipe_results.tsx +
   components/coach/blocks/index.tsx): the search and coach recipe-results surfaces now carry
   `exactMatch` through from the server/stored block and show "No exact match, closest recipes"
   above the list when it is `false` and cards remain.
5. **Verified, already wired** (components/RecipePlanFlow.tsx `useState(initialSlotId ??
   "meal-1")`): a recipe placed from search with no explicit slot defaults to Meal 1.

## t23: honest nutrition flags (#416)

6. `ChartBlockV1.partial`: some charted items have unknown nutrients. Mark the chart as partial;
   never present it as complete.
   **Wired:** `components/coach/blocks/chart.tsx` passes it to `MacroRings`' own `partial` prop
   (its "Still to eat" line says "at most"/"at least").
7. `ApplyResult.nutritionUnchecked` on a coach save: the meal was saved, but its numbers could
   not be checked. Say so on the action card ("Saved. Nutrition not checked").
   **Wired:** threaded through `lib/coach/chat-state.ts` (`action_applied`) and
   `components/coach/CoachShell.tsx`/`Transcript.tsx` into `components/CoachActionCard.tsx`, which
   shows `lib/nutrition-display.ts`'s `NUTRITION_UNCHECKED_COPY` on an applied card.
8. `UndoOutcome` is typed. It separates undone, already undone, changed since (409) and failed.
   **Wired:** `lib/coach/apply-shared.ts`'s `UndoOutcome` and `lib/coach/undo-client.ts`'s
   `UndoPlan` now carry an `already` flag (set when the record was found undone before this tap,
   or lost the race to another tap/device); `CoachActionCard` shows it as "This was already
   undone." instead of plain "Undone." The "changed since" (409 conflict) and other failure
   reasons already reached the card's `reason` line verbatim from the server
   (`lib/server/coach-undo.ts`'s `RPC_ERRORS`) — confirmed with a test, not changed.
9. `WeekSummary.averagePartial`: the week average includes days with partial nutrition. Mark the
   average.
   **Wired:** `components/today/DayBoard.tsx`'s week tile passes `eatenBound(week.averagePartial)`
   to the "Average … on logged days" `MacroFigure`.

## Phase 18 W2a: Jev off the allergy path, fail-closed (#417)

10. **Wired** (components/coach/editors/AllergenFindingLines.tsx `lineText`): a held finding's
    line now reads "`<Allergen>`: Not verified. Evidence under review" (the allergen named in
    front of the imported `HELD_ALLERGEN_TEXT`, never retyped) — shared by the barcode card, a
    scanned label and a matched capture item.
11. **Wired** (components/FoodSheet.tsx `LabelCheck`): intersects the profile's avoided allergens
    with `FoodDetail.heldAllergens` (fetched via `lib/catalog-client.ts` `getFoodDetail`); a held
    key shows the held line instead of the check, the button covers only non-held keys, and it is
    hidden entirely when every key is held. A missing `heldAllergens` (no catalog detail, or an
    older cached one) behaves exactly as before.

## Phase 18 W3: eaten history, choice episodes and GET /api/foods/taste (#438)

12. `GET /api/foods/taste`: up to 50 admitted foods with their 180-day eaten history (`days180`,
    `lastOn`, `favored`, `provenance.estimated`), highest H first.
    **Wired** (read-only half, components/EatenOften.tsx + lib/foods/taste-client.ts): the Foods
    tab's first tab now shows "Eaten often" beneath the account's own foods list — name, "Eaten on
    N days", the last day, and an "Estimated" tag when `provenance.estimated` is true, in the
    server's own order, on the shared six-then-"Show all N" list. The 409 `rule_review_required`
    shows the same copy `GET /api/foods/eligible` already shows for that state; any other failure
    (offline, a timeout, an account switch) renders nothing. **Pending:** the "Favor" one-tap
    button is structured (`onFavor?: (key) => void`, shown only when passed AND the row is not
    already favored) but not wired — it needs `POST /api/foods/favor` from the backend lane, which
    does not exist yet.
