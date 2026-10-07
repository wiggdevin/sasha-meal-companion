# Scoped review: avoid-impact route, AvoidImpact, custom-rules, eligibility, diet-client

I found 10 defects. Each one has a concrete scenario and a fix. I did not flag missing consumed-history guards on the `saveItemOverride` outbox. Two items depend on code I could not see, and I say so where it matters.

## High / Medium

**1. The badge and the modal count different things (catalog-ID matches are lost).**
- **Where:** `POST` in the route, compared with `GET` / `Query` and `readImpact`.
- **Scenario:** Avoid food "Parmesan" has `catalogFoodId=123`. A saved recipe line has `foodRefId`, which resolves to catalog 123, with the name "Parmigiano Reggiano". `POST` matches through `byCatalogId`, so the badge shows "1 affected". A click on the badge calls `readImpact` → `GET`. `Query` is `.strict()` and has no `catalogFoodId`, so it returns 0, and the modal says "No saved future meal matched". `onAvoidSaved` has the same gap: it shows "No matching saved future meal was found" even though the badge shows 1. The user cannot reach that instance through Remove, Remix or Edit.
- **Fix:** Add an optional `catalogFoodId` to `Query`. Thread it through `readImpact` from `renderAvoidStatus` and `onAvoidSaved`, and keep it with the result so `remove` and `askSasha` re-read with the same identity.

**2. Swapped slots are counted as affected, and "lower bound" is then false.**
- **Where:** `scan`, the selection loop.
- **Scenario:** A slot has a `recipe_plan_selections` row that contains "shrimp", and `plan_days.swaps[slot]` replaced that meal. The selection loop checks eaten and overrides but never checks `swaps`, so the swapped-away recipe is listed as an affected instance. The swaps loop sets `opaque`, so the UI says "N+ … this is a lower bound". The count is actually inflated. Remove then writes a removed/cleared override over the swapped-in meal, which is the wrong target.
- **Fix:** In the selection loop, skip the row when `day.swaps?.[row.slot_id]` exists and it is not eaten, removed or cleared. Keep `opaque = true` for that slot, so the count really is a lower bound.

**3. Remix and Sasha replacements are not checked against the excluded item. Remix also skips the eligibility check that Edit has.**
- **Where:** `remix`, the replacements `onClick`, and `askSasha`.
- **Scenario:** The user checks cuisine "Thai". It is only a check, not a saved rule. `similarRecipeOptions` ranks by similarity, so it favours Thai recipes. Nothing filters on `matchesRule(recipe.cuisine, {kind:"cuisine", text: query})`. The list is labelled "Verified replacement recipes", and one click calls `setFlow` with no `eligibility.status === "eligible"` check (`edit()` has that check). The same applies to ingredient checks and to the "Policy-checked food ideas" from `askSasha`: `verdict==="allowed"` only covers saved rules.
- **Fix:** Filter the candidates on `eligibility.status === "eligible"` and on "does not match the current query/kind" (use the same matcher as `scan`). Re-check both in the click handler. Change the Sasha copy so it does not claim the ideas were checked against an unsaved exclusion.

**4. The route's eaten test differs from the client's consumed test.**
- **Where:** `scan`, which uses only `eaten_slots[slot].eaten_at`, compared with `remove`, which uses `day.eaten || day.consumedSlots`.
- **Scenario:** The client code shows that two consumption records exist. A slot can be consumed (`consumedSlots`) without `eaten_slots.eaten_at` being set. The route then lists it as a *future* affected meal with `complete: true`. The count includes history, and Remove fails with "already eaten".
- **Caveat:** Whether this triggers depends on how `consumedSlots` is stored on the server, which I could not see.
- **Fix:** Use the same consumed predicate as the server-side override guard in both loops of `scan`.

**5. Edited meals are matched by name only, so `complete` is over-claimed.**
- **Where:** `scan`, the override loop.
- **Scenario:** Same as #1, but the "Parmigiano Reggiano" component is in an edited override that carries `foodRefId` or `foodDbId`. The recipe path would resolve that identity. The override path only reads `item.name`, and `mayHaveSubingredients("Parmigiano Reggiano")` is false. Result: a miss with `complete: true`.
- **Fix:** Resolve component `foodRefId`/`foodDbId` exactly as the snapshot path does. At minimum, set `opaque = true` when a component has an identity field that the route did not check.

**6. Impact and eligibility disagree, so Edit re-plans a flagged meal as "eligible".**
- **Where:** `scan` uses `matchesRule` (token containment) and `sameBaseName`. `recipeEligibility` checks Avoid names with exact `baseFoodName` equality.
- **Scenario:** Avoid "egg". A recipe line "egg yolk" has a different `foodDbId`/`foodRefId`. The impact list shows "Matched egg yolk". Edit then calls `getCatalogRecipe`, the recipe is `eligible`, and `RecipePlanFlow` re-plans the same conflicting recipe.
- **Fix:** Pick one matcher and use it everywhere. The quick fix is to make `edit()` reject the recipe when any ingredient matches the current query with the `scan` matcher.

**7. `saveDiet` lets the stale local mirror override the fresh server state, and it sends the whole row.**
- **Where:** `saveDiet` → the `mutateUserSettings` callback.
- **Scenario:** Device B sets cooking effort to "high" (server rev 5). Device A's mirror still holds effort "low" at rev 4. Device A's `loadDiet` returns rev 5, so the `baseRev` check passes. The merge is `{...before, ...mirror, flags}`, so the stale mirror's "low" wins. `payload` also carries every stale mirror field (`...stored`, for example `time_zone`), with `base_rev: 4`. Two outcomes are possible:
  - The server does field last-write-wins: device B's edits are overwritten.
  - The server rejects rev conflicts: the save fails with "Diet change is queued on this device", and the op stays queued. Whether it retries forever depends on how the outbox handles conflicts, which I could not see.
- **Fix:** Build `nextPrefs` from `before.dietPrefs`, and add only fields from pending (unflushed) ops. Send only `diet_prefs`. Set `base_rev` to `before.rev`.

**8. Out-of-order responses can show a result for a different query.**
- **Where:** `check`, the badge `onClick` in `renderAvoidStatus`, and `onAvoidSaved`.
- **Scenario:** The user checks "egg", then types "eggplant" or clicks another badge. `isCurrent(h)` only checks the account, so the late "egg" response calls `setResult` while `query` says "eggplant". The rows say "Matched egg". `remove` and `askSasha` then re-read with "eggplant" and match rows by `date:slot` only. A slot that matches both passes verification and is removed under the wrong label and reason.
- **Fix:** Add a request-sequence ref. Store `{q, kind}` inside `result`, and use `result.q/kind` in `remove` and `askSasha`, not the live `query`/`kind`.

## Low

**9. One bad Avoid name breaks every badge.**
- **Where:** `Batch` / `refreshBadges`.
- **Scenario:** Any Avoid food with a trimmed name shorter than 2 or longer than 80 characters, or an id longer than 128, makes `Batch` return 400 for the whole chunk. Every badge then shows the error.
- **Fix:** Skip or clamp invalid items on the client, and mark those foods "cannot check".

**10. A successful removal is reported as a failure.**
- **Where:** `remove`.
- **Scenario:** The removal succeeds, but the final `setResult(await readImpact(...))` throws. The catch shows "Could not remove this meal". A retry then fails with "This meal changed".
- **Fix:** Put the post-success refresh in its own try block.

Also minor: `onAccountGone` does not reset `confirmRemove`, `kind` or `editRules`. This is harmless today because `result` is cleared.
