# Shopping A12/A15 implementation report

Scope: Shopping components, `lib/shopping-client.ts`, focused Shopping tests. This worker made no commit, push, production access, DDL, database write, server restart, or full-suite run. Root separately captured the local synthetic-account browser proof in `root-live-evidence.md` and `shopping-manual-browser.json`, then supplied an independent review in `opus-shopping-review.md` for this worker to address. This worker made no model call.

## A12 verdicts

| Criterion | Verdict | Evidence / limit |
|---|---|---|
| Plan and save without location or currency | YES (manual-list path) | Budget and area do not disable preview; blank period save uses existing `POST /api/shopping/periods`. `tests/shopping/ui.test.tsx` covers budget with `currency: null` and no area. Root saved a blank list without budget/location/currency on localhost3145 with a synthetic account. Generated-plan accept remains unverified. |
| Optional coarse area and tap-only browser location | YES (focused UI) | Area is visible regardless of budget. `getCurrentPosition` is called only in the button handler and coordinates are rounded to 2 decimals. `tests/shopping/ui.test.tsx` verifies no call before tap. No geoIP inference. |
| Real nearby stores, single/multiple selection | NO | No approved store-search integration or credential contract exists in `.env.example`, `app/`, `lib/`, or package dependencies. No stores are shown or invented. The optional account-scoped device note preserves store names the user enters, but it is not a provider-backed store selection. |
| Actual local prices with provenance/freshness | NO | `lib/shopping/aggregate.ts` can consume sourced quotes, but the Shopping preview calls it without a quote provider. No licensed grocery product/price feed, store SKU mapping, quote freshness pipeline, or usable credential is wired. Cost stays unknown and no bill guarantee is shown. |
| Useful preferences while provider is blocked | YES (device scope) | Area and preferred-store notes persist in account-keyed local storage; accepted periods also persist their `locale` through the existing server period. Store notes are labeled device-only. `tests/shopping/root.test.tsx` checks separate account keys. |

## A15 verdicts

| Criterion | Verdict | Evidence / limit |
|---|---|---|
| Reproduce reported population error and fix its root cause | NO | The exact reported Shopping response was not captured. Source trace shows Shopping preview uses `loadRecipeCandidates`; the screenshot's policy/evidence failures can leave slots unfilled. That shared recipe-policy cause belongs to the other worker; see `shopping-policy-handoff.md`. A focused test reproduced the client masking `rule_review_required` as a generic 409, and the client now shows a review action. |
| Generate, save, list, reopen, edit | NO overall; YES manual-list browser path | Preview/accept flow remains; blank lists can be saved with the existing period API when recipes cannot populate. Saved list retrieval no longer filters to 30 days around today, and GlassSelect opens an older list with the owner-scoped GET. Root's localhost synthetic account saved, reopened and edited a manual list. Generated-plan population/accept has not passed browser proof. |
| Checks, manual items, notes and locks survive reload/replanning | NO overall; YES manual reload subset | Root's localhost receipt shows manual name, bought mark and note persisted after reload and reopen. Existing `preserveEditedLines` and UI tests pass. Manual freeform items have no ingredient identity, so the misleading disabled pin is now hidden. Canonical ingredient locks, generated list replanning, and their reload behavior remain unverified. |
| Recoverable empty/errors, no false saved claim, account isolation | YES (focused client flow), NO (live multiuser proof) | Empty state explains how to save; failed blank create leaves it unsaved; a successful create followed by refresh failure says saved but not reloaded. Server reads/PATCH remain owner-scoped; account-keyed device preferences have a focused test. Stale list loads cannot replace a newer selection; an old account's blank-save completion cannot alter the new account's busy state. Stale line/window/pantry edits reload the list and ask the user to retry; late accept completion cannot switch the account's list. Multiuser database check remains for the root integration window. |

## Checks

- `mise exec -- pnpm exec vitest run tests/shopping/root.test.tsx tests/shopping/ui.test.tsx tests/shopping/ui-client.test.ts tests/shopping/ingredient-picker.test.ts tests/shopping/ingredient-picker-ui.test.tsx tests/shopping/preview-contract.test.ts tests/shopping/preserve.test.ts` — **56 passed, 7 files**.
- `mise exec -- pnpm exec eslint components/ShoppingRoot.tsx components/ShoppingControls.tsx components/ShoppingView.tsx components/ShoppingLineCard.tsx components/ShoppingPurchaseWindowCard.tsx components/ShoppingIngredientPicker.tsx lib/shopping-client.ts tests/shopping/root.test.tsx tests/shopping/ui.test.tsx tests/shopping/ui-client.test.ts tests/shopping/ingredient-picker-ui.test.tsx` — **passed**.
- `git diff --check` for the Shopping files — **passed**.
- `mise exec -- pnpm exec tsc --noEmit --pretty false` — **passed** after the concurrent recipe test fixture was repaired by its owner.

The remaining native Shopping purchase-state menu now uses shared `GlassSelect` with the exact existing values. Focused UI coverage checks the selected identity and resets search/purchase state when accounts switch. No duplicate selector or shared style file was added.

Save blank list, add manual item, rename item and save notes now use the shared action feedback. Success feedback follows a confirmed server write. If a subsequent refresh fails, the server result is kept in the phone projection and the UI says it saved but could not reload. Failed saves preserve the draft and do not show success. The source-keyed name/note inputs reflect fresh server values without unmounting the feedback toast.

The independent review found client races. `accountFetch` and `accountJson` already assert the initiating account before returning a response, and accept now asserts it explicitly before changing UI state. Accepted and blank-list IDs become the selected ID before refresh, so a failed or superseded refresh cannot switch the view to an empty new list. A replan with a changed period revision or new line IDs refreshes the basket from current ingredients. An unchanged tab-return refresh no longer discards a preview. Stale row edits fetch the latest list and show a retry message. Name and note save controls have separate feedback; bought, pin and stock saves also show confirmed feedback. Focused tests cover these paths.

Review P2 limit: switching lists still discards unsaved input drafts without a confirmation. The existing UI has no shared dirty-state contract across the planning form and line cards, so this worker did not add an incomplete guard. Saved server edits remain durable.

## Root integration gates

1. Finish recipe candidate/evidence and rule-review work, then capture the actual Shopping preview error and a successful generated-list preview on a safe local branch.
2. Root's synthetic browser proof covers blank-list save and manual name/bought/note reload. The remaining local proof is generated-plan save/replan, canonical ingredient lock preservation, and a second user's isolation. The Shopping schema migration is already in branch source; this worker added no DDL.
3. If real store and price discovery is desired, supply an approved licensed provider with store search, product mapping, credentials, billing permission and quote freshness. The current branch cannot truthfully implement those criteria.
