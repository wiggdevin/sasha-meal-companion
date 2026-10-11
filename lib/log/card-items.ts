/**
 * The card's items when a server row answers for them.
 *
 * Its own module so lib/log-commit-settle.ts stays under 400 lines. Every rule it holds was found
 * one at a time: panel round 15 (the row's items are the entry's), Grok pass 20 HIGH 1 (except the
 * ones the wire never carried), Grok pass 21 MEDIUM 3 and MEDIUM 4.
 */
import { amountLabel, massOf, relabelLostMass } from "@/lib/log/mass";
import type { LoggedFood } from "@/lib/types";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/capture/label-food";

type Item = NonNullable<LoggedFood["items"]>[number];

/**
 * The card's items, brought up to the server's row.
 *
 * Every item the wire carried follows the row: the server's version by id, a food another device
 * added appended, and one it no longer has dropped — mapping over the CARD's items could only
 * update what it already had, so the day's rings stayed a meal short (panel round 15).
 *
 * An item the wire never carried is the exception. A meal can mix catalog foods with one of them
 * own, a bundled pick or an offline match, which `mealEntryItems` keeps on the card under a
 * `local:` ref and never sends. The row cannot speak for those, and replacing the list with it
 * took them off the card and out of the totals (Grok pass 20, HIGH 1).
 *
 * Two lines are collapsed on identity alone — the same item id, which is the only thing both
 * sides agree on. Not on seq: the card numbers every line and the request only the catalog ones,
 * so the two lists count differently and a bundled line claimed the row of the food after it,
 * which then vanished. Not on grams and unit either: two 100 g portions are not one food
 * (Grok pass 22, HIGH 2).
 *
 * The cost is the known limitation pass 21 MEDIUM 4 aimed at: if the server ever stores a local
 * pick under an id of its own, the card holds the local line and the row arrives beside it. That
 * is a pull-time reconciliation for another device's replay, not something to guess at here.
 */
export function mergedItems(
  entry: LoggedFood, rows: Record<string, unknown>[],
): Item[] {
  const fromRow = new Map(rows.map((row, i) => {
    const item = itemFor(row, i, entry);
    return [item.id, item] as const;
  }));
  const held = (entry.items ?? []).flatMap((item) => {
    const answered = fromRow.get(item.id);
    if (answered) { fromRow.delete(item.id); return [answered]; }
    return item.food_ref_id.startsWith("local:") ? [item] : [];
  });
  return [...held, ...fromRow.values()];
}

/**
 * One stored row as a card item: the server's numbers, their own words where the card has them.
 *
 * Everything the row carries is the row's — the ref, the seq, the quantity, the unit, the grams,
 * the snapshot. Their words are kept only while the line is still the same FOOD: a row that points
 * this id at a different ref describes something else, and keeping the card's name and macros
 * over it says the line is a food the server no longer has there (Grok pass 21, MEDIUM 3).
 */
function itemFor(
  row: Record<string, unknown>, index: number, entry: LoggedFood
): Item {
  const held = entry.items?.find((item) => item.id === row.id);
  // A row that says null says the mass is unknown (t17); only a row with no grams key at all falls
  // back to the card's. Never 0.
  const grams = massOf("grams" in row ? row.grams : held?.grams);
  const snapshot = (row.snapshot ?? held?.snapshot ?? {}) as Item["snapshot"];
  const food_ref_id = typeof row.food_ref_id === "string" ? row.food_ref_id
    : held?.food_ref_id ?? "";
  const seq = typeof row.seq === "number" ? row.seq : index + 1;
  const qty = typeof row.qty === "number" ? row.qty : held?.qty ?? grams ?? 1;
  const unit = typeof row.unit === "string" ? row.unit : held?.unit ?? "g";
  // A label saved as their own food went up under the placeholder; the row names its real ref (A030).
  if (held && (held.food_ref_id === food_ref_id || held.food_ref_id === LABEL_FOOD_PLACEHOLDER_REF)) {
    return relabelLostMass(held, { ...held, seq, food_ref_id, grams, qty, unit, snapshot });
  }
  return {
    id: String(row.id ?? `${entry.id}:${index}`),
    seq, food_ref_id, grams, qty, unit, snapshot,
    // Nothing on the wire says what it is called: the row is numbers and ids. The macros come
    // from the snapshot the same way every other item's do (lib/resolve.ts's entryMacros).
    foodId: "catalog:0", name: "Added on another device", portionLabel: amountLabel({ grams, qty, unit }),
    macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  };
}
