/**
 * A card rebuilt from a commit request alone. Split out of lib/log/reconcile.ts (W027) so that
 * module stays under the house rule; nothing moved but the function.
 */
import { deriveMealTitle } from "@/lib/coach/meal-title";
import type { LogCommitRequest } from "@/lib/log/contract";
import { amountLabel, entryMass } from "@/lib/log/mass";
import type { LoggedFood } from "@/lib/types";

/**
 * The last resort: a card for an entry whose own card is gone and whose record never kept one.
 *
 * What the request knows is ids, grams, units and their note — not what the user called the food. So it
 * is named the way a saved meal with no name of its own is named, and the macros are zero until
 * the reply or the read-back fills the snapshots in, which is what every card's totals come from
 * (lib/resolve.ts's entryMacros). A pending mark over a plain card is the honest state: the meal
 * is theirs, and it is still on its way.
 */
export function cardFromRequest(req: LogCommitRequest, previous?: LoggedFood): LoggedFood {
  const previousName = previous?.name.trim();
  const derived = deriveMealTitle(previous?.items ?? []);
  const count = `${req.items.length} item${req.items.length === 1 ? "" : "s"}`;
  // With no card and no record, the request still knows how many items it carries.
  const title = req.title?.trim()
    || (previousName && previousName !== "Logged meal" ? previousName : derived)
    || (previous ? "Logged meal" : `Meal · ${count}`);
  if (previous) {
    return {
      ...previous,
      id: req.entry_id,
      name: title,
      slot: req.slot,
      at: req.eaten_at,
      ...(req.note?.trim() ? { note: req.note } : {}),
    };
  }
  const { grams, massUnknown } = entryMass(req.items);
  return {
    id: req.entry_id, foodId: "meal",
    name: title, slot: req.slot,
    portionLabel: count, qty: 1, grams, ...(massUnknown ? { massUnknown: true as const } : {}),
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    ...(req.note ? { note: req.note } : {}),
    items: req.items.map((item, i) => ({
      id: item.id, seq: item.seq ?? i + 1, food_ref_id: item.food_ref_id, grams: item.grams,
      qty: item.qty, unit: item.unit, snapshot: {},
      foodId: "catalog:0", name: "Logged food", portionLabel: amountLabel(item),
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    })),
    at: req.eaten_at,
  };
}
