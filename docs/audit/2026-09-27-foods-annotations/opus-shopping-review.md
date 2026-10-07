## Shopping review: 2 P0/P1 and 3 P1 bugs, 3 P2 issues, 5 untested areas

I reviewed only the code you pasted and ran nothing. Each finding is marked as either a bug the code shows or something the tests don't prove.

### P0/P1: bug in the code (P0 if it reproduces)

**1. `ShoppingRoot.tsx` › `actions.preview` › `accept`: no account check after the await.** Every other mutation (`patchLine`, `patchWindow`, `confirmPantry`, `addManual`, `saveBlankList`) calls `assertCurrent(account)` after its await. `accept` does not. It calls `setSnapshot(accepted)` and `refresh(accountHandle(), …)` without that check.
- **Scenario:** A accepts a plan. While the request is in flight, A signs out and B signs in. `onAccountReady` resets the state. Then the late response writes A's period and lines into B's view.
- `refresh(B, A.periodId)` then throws "no longer available". The catch shows "Plan accepted…" to B, and B keeps seeing A's list. The `recipe-plan-accepted` event also fires in B's session.
- **Not proven:** this is only harmless if `accountJson(h, res)` already rejects when `h` is stale. Check that. If it does not reject, this is P0.
- **Fix:** capture `account` before `acceptShopping`, call `assertCurrent(account)` before `setSnapshot`, and check the epoch in the catch.

### P1: bugs in the code

**2. `ShoppingRoot.tsx` › `accept` and `saveBlankList`: the list you just saved can disappear from view.** `selectedId.current` changes only inside a `refresh` that succeeds.
- **Scenario A:** you accept from "New list" and the refresh after it fails. The accepted list still shows, but `selectedId` is still `null`. Pressing the banner Retry, or returning to the tab, calls `refresh` with no id. With `hasSelection` true, that picks no list and swaps the view to an empty "New list". The user thinks the save was lost.
- **Scenario B (also affects blank lists):** you switch apps while the refresh after save or accept is still running. The `visibilitychange` refresh takes a newer serial and replaces the save's refresh, and it runs with `selectedId === null`. Same result: an empty new list.
- The `saveBlankList` fallback sets `selectedId` only on the error path, so a refresh that gets replaced still hits Scenario B.
- **Fix:** set `selectedId.current` and `hasSelection.current = true` to the saved or accepted id before you call `refresh`.

**3. `ShoppingView.tsx` › `basket` state: the basket goes stale after you re-plan an existing list.** `basket` is filled once, when the component mounts. The `ShoppingView` key is `${epoch}:${periodId}`, and re-planning keeps the same period id, so the view does not remount.
- **Scenario:** you re-plan saved list P and accept. The new ingredients show "Use in next plan" unchecked. The next preview sends a basket without them, so they can drop out of the next plan.
- This is a client bug either way; how bad it gets depends on how the server reads the basket (not proven).
- **Fix:** rebuild the basket when `period.revision` changes or when a new line id appears, or add the revision to the key. The key option loses unsaved edits.

**4. `ShoppingLineCard.tsx` › `run` (bought, pin and stock errors) and `ShoppingView.tsx`: no way to recover from a stale-revision error.** A 409 on a line change shows "Shopping changed elsewhere. Refresh and preview again."
- `ShoppingView` never shows a control for `actions.refresh`. The root Retry banner appears only when the root `error` is set, and a card error does not set it.
- **Scenario:** you edit on your phone, then tick Bought on your laptop. You get the error, and every later toggle fails the same way until you switch tabs or reload the page. The message also says "preview again", which is wrong for a line change.
- **Fix:** in `ShoppingRoot` `patchLine`, `patchWindow` and `confirmPantry`, catch the stale error, call `update()`, and throw a clear line-level message.

### P2

**5. `ShoppingRoot.tsx` › `refresh` bumps `invalidateRevision` on every call, including tab-return refreshes.** You open a preview, switch apps to check something, and come back: the preview is gone and you must preview again. Bump the counter only when the period revision or line revisions actually change.

**6. `ShoppingRoot.tsx` › the `GlassSelect` onChange and the "New list" button remount `ShoppingView` with no warning.** Typed but unsaved notes, manual names and stock amounts are discarded without a message. Your requirement covers saved notes, so this is only P2.

**7. `ShoppingLineCard.tsx`: two small feedback gaps.**
- "Confirm stock", Bought and Pin give no success feedback. Only failures show anything.
- The name and note Save buttons share one `feedback` hook, so saving a name also shows the pending and success state on Save note.

### Not proven by tests (not confirmed bugs)
- A re-plan keeps manual lines, notes, `checked` and `pinned` on lines it regenerates. This is server logic and none of it is visible here.
- Isolation of generated and re-planned lists across accounts: whether the server rejects `periodId` and `previewId` from another account, and whether `accountJson` rejects a stale handle. The second one decides whether finding 1 is P0.
- An `acceptShopping` retry with the same `requestId` after a lost response returns the same snapshot and does not re-plan twice.
- A lost response on `createShoppingPeriod` followed by Retry does not create a duplicate. The code looks right: `blankRequestId` is kept.
- The 409 stale-revision paths for line, window and pantry changes (finding 4).
