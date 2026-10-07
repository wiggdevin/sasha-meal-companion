# Foods UI source audit (A02–A07, A13, A14)

I found two bugs I'd fix before release. First, food edits (group and nutrition) skip the sync path, so other devices never receive them. Second, a food added to Avoid from the catalog is first saved to the server as Eats. Everything else is medium or low.

This was a read-only review; I changed nothing. I read the files in the brief plus `components/Sheet.tsx`, `components/add-food/catalog-food.ts`, the RLS and `apply_sync_op` migrations, a grep for triggers, and `FoodsTabs.tsx` for the `#avoids` link. I did not open `lib/recipes/use-recipe-sheet.ts`, `lib/foods/adopt-client.ts`, `CatalogRecipeResults.tsx`, `EatsView.tsx`, the other screens that now use GlassSelect, or any test except `GlassSelect.test.tsx`. I made no browser, database or network calls.

## Bugs

### High

**1. Food edits don't sync to other devices.**
- **Where:** `lib/foods/prefs-client.ts:490-493` and `:504-508`.
- **What:** `saveFoodEdits` writes nutrition and group straight into the tables with `.update(...)`, and sets `rev: row.rev + 1` itself.
- **Why it breaks:** Only the `apply_sync_op` RPC writes the change log that other devices pull from (`20260911000600_rpc.sql:377-378`). The only triggers on these two tables are `recipe_plan_bump_state` (`20261128090000_recipe_plan_accept.sql:96-99`). The local IndexedDB mirror is not updated either.
- **Result:** Other devices never see the edit. A later preference write from another device can put the old group back.
- **Why the reload test passed:** Reload on the same device reads localStorage, so it looks saved. Cross-device persistence for A04 is unproven.
- **Fix:** Copy the pattern in `components/add-food/catalog-food.ts:59-81`:
  - For group: read the preference `rev`, then call `apply_sync_op` with `base_rev`, then `putRow`.
  - For nutrition: queue a `user_foods` update through `enqueue` (as `catalog-food.ts:52` does) instead of the direct update.

**2. Adding a catalog food to Avoid saves it as Eats first.**
- **Where:** `components/add-food/catalog-food.ts:56`, `:58`, `:65-71`; `components/MyFoods.tsx:393-398`.
- **What:** `addCatalogFood` always sets the whole name to Eats on the server. `AvoidFoods` then flips it to Avoid with a second save.
- **Why it matters:** That second save can fail before it queues anything (`prefs-client.ts:496-498` throws before `setFoodMembership`). The server and every other device then treat a food the user meant to avoid as Eats, while this phone shows it on Avoid. This is a dietary-safety problem.
- **Fix:** Give `addCatalogFood` a target-status argument (`"eats" | "avoid"`) and use it at lines 56, 58 and 65, so an Avoid add is written once, as Avoid.
- **Not checked:** the built-in food path (`adoptBundledFood`) may have the same problem; I didn't read it.

### Medium

**3. Saving a note, group or nutrition change can undo a newer Eats/Avoid change.**
- **Where:** `lib/foods/prefs-client.ts:500`, `:123`.
- **What:** Every Save re-sends the food's status from this device with a fresh revision number.
- **Example:** The user moves a food to Avoid on their phone. Before this device syncs, they edit the food's note here. The note save sends Eats with a newer revision and wins.
- **Fix:** Only send the membership operation when the note actually changed. When sending, use the status the server last confirmed (`readFoodMembership`), not the possibly stale `food.status`. A group or nutrition-only edit should never send status.

**4. Save can report failure after it partly saved.**
- **Where:** `lib/foods/prefs-client.ts:484-509`; `components/MyFoods.tsx:279-282`.
- **Case 1:** Nutrition is written to the server first. If a later step fails, `onSave` throws before `upsertFood`. The app says "Could not save", but the server has the new nutrition and the phone has the old.
- **Case 2:** Offline, or on a food's first mark, the confirmation call fails (lines 316-324). The group update then matches no row and throws `FoodMembershipSaveError`, even though the membership change is safely queued.
- **Fix:** Queue every write through the sync outbox (this falls out of fixing #1). Report "Saved — syncing" when the write is queued, and only report failure when nothing was queued.

**5. Removing a food from Avoid happens instantly, with no undo.**
- **Where:** `components/MyFoods.tsx:353-355`.
- **Why it matters:** One swipe and a tap puts an avoided food back into meal planning.
- **Fix:** Show a short Undo toast after Remove. Undo restores the previous status. This is one control, not a confirmation dialog.

**6. Adding an avoided food from an Eats card silently moves it to Eats.**
- **Where:** `components/AddFoodSheet.tsx:100-101`, `:209-213`.
- **What:** `reAddedFood` always sets the status to `"eats"`.
- **Fix:** If the prior status is `avoid`, show one line in the sheet ("This is on Avoid — add it back to Eats?") and require that tap.

### Low

**7. Remove can't be reached with a mouse.**
- **Where:** `components/MyFoods.module.css:1-16`.
- **What:** The Remove button has zero width until a touch swipe or keyboard focus. Keyboard and screen readers can reach it; a desktop mouse cannot.
- **Fix:** Add `@media (hover: hover) { .row:hover .remove { … } }`, or also reveal the button on `:focus-within`.

**8. A slightly diagonal scroll reveals Remove.**
- **Where:** `components/MyFoods.tsx:61-67`.
- **What:** The swipe checks only horizontal movement.
- **Fix:** Record the start Y as well, and only treat it as a swipe when horizontal movement exceeds 36 px and is larger than vertical movement.

**9. Changing Eat/Avoid in the food sheet discards unsaved edits.**
- **Where:** `components/FoodSheet.tsx:76-78`.
- **What:** The status button saves the note but silently drops unsaved group or nutrition changes. Save and the status button can also run at the same time.
- **Fix:** Disable the status button while there are unsaved changes or a save is running, or save first.

**10. Nutrition fields can appear and then refuse to save.**
- **Where:** `lib/foods/prefs-client.ts:419` vs `:468-471`.
- **What:** When two rows share a name, one mapped to the catalog and one not, the fields show but Save throws "cannot be edited".
- **Fix:** Look up the row by the food's own id, or hide the fields when the row found is mapped.

**11. GlassSelect can show a value that isn't the real value.**
- **Where:** `components/ui/GlassSelect.tsx:32`.
- **What:** When the value is not in the options, the button shows the first option. The hidden form field still holds the original value (line 95).
- **Fix:** Fall back to "Choose" instead.

**12. GlassSelect: Escape can close the whole sheet.**
- **Where:** `components/ui/GlassSelect.tsx:109-114`; `components/Sheet.tsx:86-89`.
- **What:** Clicking an option can move focus onto it (except in Safari). The keyboard handlers only live on the trigger, so Escape then reaches the sheet's listener and closes the whole sheet.
- **Fix:** Add `onMouseDown={e => e.preventDefault()}` to each option so focus stays on the trigger.

**13. Recipe filters don't submit and aren't validated.**
- **Where:** `components/RecipeDiscovery.tsx:78-97`.
- **What:** The filter inputs sit outside the `<form>`. Enter in Cuisine or Max minutes does nothing, and the `min="1"` rule is never enforced, so `"0"`, negative or decimal minutes are sent. Changing a filter does not re-run the search.
- **Fix:** Move the filters inside the form, and send minutes only if they are a whole number of 1 or more.

**14. Recipe star errors are unhandled.**
- **Where:** `components/RecipesSection.tsx:61-64`.
- **What:** `toggleRecipeStar` has no catch and no account check, so a failure is an unhandled promise rejection.
- **Fix:** Wrap it in try/catch and check `isCurrent(h)` before updating.

**15. The saved-recipes list goes stale.**
- **Where:** `components/RecipesSection.tsx:66-75`.
- **What:** The list doesn't refresh when a sync finishes, so edits or deletes made on another device don't show until the section remounts.
- **Fix:** Listen for `SYNCED_EVENT`, as `MyFoods` does.

**16. Unconfirmed: a deleted recipe may stay in Favorites.**
- **Where:** `lib/recipes-client.ts:83-94`.
- **What:** Soft-delete leaves the favorite row in place. I didn't check whether the Favorites list filters out deleted recipes.

## Checked and fine

- **Account switching:**
  - Food search, catalog add and built-in add results are dropped after an account change.
  - The sheets close and the lists clear.
  - Recipe discovery checks both the request id and the account.
  - `RecipeSheet` checks the account before save and delete.
  - Server writes go through `withAccount`.
- **Recipe delete:** it refuses a stale local revision (`recipes-client.ts:87`) and is a soft delete, so logged servings keep their snapshots. A server-side conflict from another device relies on `base_rev`, and I didn't check how the outbox handles a rejection.
- **GlassSelect inside a sheet:** the list is placed in the sheet's outer container, which has no transform, so the fixed position is correct. Escape pressed on the trigger stops before the sheet sees it.
- **"Review food rules in Avoids" link:** `#avoids` switches to the Avoids tab (`FoodsTabs.tsx:40`).

## Requirement gaps and open decisions (not bugs)

- **A03:** The filters sit inside a collapsed "Recipe filters" section. On mobile, minutes and effort do share a row, but a collapsed section may not be what the user meant by compact fields in one row. The user should rule on this.
- **A05:** The Add footer on "Other foods" adds the food to Eats, not to Other (`MyFoods.tsx:260-261`, `292-293`). Whether Other counts as a category needs a ruling.
- **A07:** I did not verify that shared catalog recipes stay unchanged (`CatalogRecipeResults.tsx` and any save-a-copy path are unread). Save for an existing recipe does no local stale-revision check; it relies on the server.
- **A13:** Not done by the report's own account. `ShoppingIngredientPicker` is owned elsewhere, and I didn't inventory the remaining native `<select>` elements.
- **A14:** The shared component and its tests exist, but the tests run only in jsdom (a simulated browser). Touch, list scrolling, placing the list above the field near the bottom of the screen, contrast, and screen-reader output are unproven.

## Still to prove before acceptance

1. Real-device checks for GlassSelect: touch, keyboard, VoiceOver, scrolling the list inside a sheet, and the upward-opening list at the bottom of a phone screen.
2. Two devices or two accounts:
   - An edit made on device A shows up on device B after a pull. This will fail until #1 is fixed.
   - Adding a catalog food to Avoid lands as Avoid on the server (#2).
   - Other accounts are unaffected.
3. Browser run of the full recipe cycle: create, edit, delete, reload, and the favorite's state after delete.
4. The mobile filter layout at 390 px after the correction (the existing screenshot predates it).
5. A browser inventory of every dropdown for A13.

This is not a final acceptance. Each item still needs the two independent verdicts the acceptance document requires.