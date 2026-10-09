# Edit a slot card item by item, and build a meal from anything

Plan, 2026-09-14. Status: item-level slot editing (`add_slot_item`/`remove_slot_item`/`set_slot_item`,
`lib/coach/actions/slot-items.ts`) and the `recipe:<uuid>` swap namespace (`lib/resolve.ts`,
`lib/sync/plan-days-schema.ts`) are built. Phases C ("build a meal from anything") and D ("Make
this my usual") below are separately unverified — confirm before relying on them.

## What she wants

Tap any card under Plan and change what is actually in it, on the fly.

- Tap **Latte** -> tap the milk -> search or type what she really used -> calories update.
- Tap **2 pouches - banana & carrot** -> "I just had a banana instead" -> pick banana.
- Swap a meal by **building her own**, from anything, not only the built-in options.
- Keep a meal she built, because she will eat it again.

## Three decisions, already made (Devin, 2026-09-14)

1. **Changing one item recalculates, it does not rebalance.** The slot's total becomes what she
   actually had, and the card shows the difference against that slot's target. No other item on
   the card is resized. `lib/scaling.ts` is untouched: it still sizes the authored plan, and it
   still never moves protein.
2. **An edit belongs to that day.** A one-day override, with a "Make this my usual" button that
   promotes it deliberately. An edit never silently rewrites future days — the failure mode the
   Loop 010 run found in the per-slot time editor, where one edit moved that slot on every date of
   every day type.
3. **A saved meal becomes a recipe AND a swap option for that slot.** It does not enter the
   deterministic rotation, so the planner never serves her something she did not ask for.

## What the code already gives us

| Piece | Where | Note |
|---|---|---|
| `Meal { components: FoodComponent[] }` | `lib/types.ts:59` | Every card is already a list of components |
| `FoodComponent { name, qty, unit, role, macros }` | `lib/types.ts:46` | `role` is protein / carb / fat / free |
| Resolution order: swap > Floor Day > rotation | `lib/meals.ts` `resolveMeal` | Where an override has to slot in |
| `plan_days(day_type_override, floor_day, swaps, slot_notes, rev)` | migrations | Per-day, per-slot state already syncs |
| `savePlanDay` -> outbox op | `lib/plan-day-client.ts` | The write path to copy |
| `resolveDay` | `lib/resolve.ts` | Shared by the Today screen AND MCP `get_day` |
| `recipes` / `recipe_revisions` / `recipe_items` | migrations | Saving a meal needs no new table |
| Catalog search over 13,700 foods | `/api/foods/search` | The picker already exists |

**The blocker for the latte case:** the ritual slots are authored coarsely. The latte is ONE
component, `freeItem("Oat milk latte", 1, "cup", 3, 17, 5)`, and the pouches are one component,
`"Fruit pouch x2 (pear & banana)"`. There is no milk to tap yet. Phase B creates one.

## Phase A — make one component editable

**Goal:** tap a card, tap any line in it, change or remove it, add a line. That day only.

- Store the **whole resulting component list** for an edited slot, not a patch keyed by position.
  A positional patch rots the moment the rotation or an authored meal changes; the stored list is
  a faithful record of what she had.
- New `plan_days.item_overrides` jsonb: `{ [slot]: { baseMealId, components: FoodComponent[] } }`.
  Migration, `_sync_upsert` plan_days branch, and the `savePlanDay` payload all move together.
- `resolveDay` applies an override after the swap/Floor-Day/rotation choice, and recomputes the
  slot's macros as the sum of its components.
- The card shows the slot target and the difference, per decision 1.
- Edit sheet reuses the existing catalog picker, plus free entry from a label for anything not in
  the catalog.

**Guards.** Every added or edited item runs `bannedReason` on the client and `evaluatePolicy` on
the server — an override must never become a way to put gluten, dairy or apple into the plan. The
existing tests that say no meal anywhere contains apple, gluten or dairy, and that an avoided food
never appears in any date's plan, must pass against overridden days too, not only authored ones.

**Sync.** Use the rev guard, not a clamp. Today's water fix is the lesson: `greatest()` silently
discarded her corrections while reporting success. An override is a correction by definition.

## Phase B — decompose the rituals, without changing a single macro

Re-author the coarse ritual components so there is something to tap:

- `coffee`: "Latte" -> espresso + milk.
- `pouches-pre`: "2 pouches" -> the pouches + the fruit, as separate lines.

**This must be macro-neutral.** `Meal.macros` is documented as "Sum of components. Precomputed for
speed; must be validated by test." Decomposition changes presentation only: each meal's total
macros must be byte-identical before and after, and a test asserts exactly that per meal. If a
decomposition cannot hold the total, it does not ship — `../analysis/targets.md` owns the numbers
and nothing here re-derives them.

## Phase C — build a meal from anything

Today `BuildMealSheet` takes one protein, one carb and one fat from her own foods.

- Allow any number of items, from her foods, from catalog search, or typed from a label.
- Show the running total against the slot target while she builds.
- "Log it" writes it as that slot's override for the day (Phase A's mechanism).
- Keep the one-tap sizing that exists now as a starting point, not a constraint.

## Phase D — "Make this my usual"

- Saves the built or edited meal as a **recipe** (`recipes` + `recipe_revisions` + `recipe_items`),
  which already syncs and already appears in search.
- Registers it as a **swap option for that slot**. `swaps[slot]` currently holds a built-in meal id,
  so user recipes need their own namespace — `recipe:<uuid>` — and `resolveMeal` must resolve it.
  This is the one change to the resolution path, so it is last and on its own.
- It does **not** enter the rotation.

## Risks worth naming

1. **Two ways to change a slot.** A swap and an override can both apply. Decide once and test it:
   an override wins over a swap, and picking a new swap clears the override for that slot.
2. **`resolveDay` is shared with MCP.** `get_day` must return the edited day, or the coach and the
   Today screen disagree about what she ate. F-042's acceptance already requires they match.
3. **Offline.** Overrides queue like any other write. After today's fix, an outbox write schedules
   its own sync, so this path is already sound.
4. **Open ruling, upstream of Phase A's guard:** whether a blocked item is refused or logged with a
   flag is still undecided (W3-10 says refuse, R6 and F-029 say flag). Phase A must follow whichever
   Devin picks; it should not quietly choose.

## Suggested order

A -> B -> C -> D. A is the mechanism and the migration. B is data only and low risk once A's tests
exist. C is UI on top of A. D touches resolution, so it goes last and alone.
