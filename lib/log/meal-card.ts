/**
 * The meal card: what "Log a meal" puts on Today, and the items inside it.
 *
 * Split out of components/LogFoodSheet.tsx when that file passed the 800-line hard max (Grok
 * pass 3, LOW 10); no behaviour moved with it. It is pure and takes what it needs, so the card the
 * commit shows optimistically and the card `onAdd` files are provably the same object.
 */
import { entryMass } from "@/lib/log/mass";
import type { LoggedFood, LoggedItem, Macros } from "@/lib/types";

/** The meal's own macros: the components' sum, rounded the way every other total on Today is. */
export function sumMacros(items: LoggedFood[]): Macros {
  const t = items.reduce(
    (a, i) => ({ protein: a.protein + i.macros.protein, carbs: a.carbs + i.macros.carbs, fat: a.fat + i.macros.fat, kcal: a.kcal + i.macros.kcal }),
    { protein: 0, carbs: 0, fat: 0, kcal: 0 }
  );
  return { protein: Math.round(t.protein * 10) / 10, carbs: Math.round(t.carbs * 10) / 10, fat: Math.round(t.fat * 10) / 10, kcal: Math.round(t.kcal) };
}

/**
 * The meal card's items, carrying THE SAME ids the commit sends.
 *
 * A catalog food added in meal mode is two objects: the component extra the sheet lists, and the
 * `catalogItems` row the request is built from, which has its own `itemId`. The card used to
 * stamp the extra's id, so `reconcileEntry`'s join by item id never matched and the server's
 * grams, snapshots and off-plan flags never reached a logged meal (Grok pass 2, HIGH 5).
 *
 * The catalog rows ARE the id space: they are what the request is built from, so they are the only
 * evidence about which id the server will answer under. An extra's own items are not — an extra
 * can carry several, and the first of them is a guess (Grok pass 4, LOW 5). A bundled pick has no
 * catalog row and is never sent, so it keeps the extra's id.
 */
export function mealEntryItems(
  items: LoggedFood[],
  catalogItems: { entryId: string; itemId: string; unit: string }[],
): LoggedItem[] {
  return items.map((it, i) => ({
    id: catalogItems.find((c) => c.entryId === it.id)?.itemId ?? it.id,
    seq: i + 1,
    food_ref_id: it.items?.[0]?.food_ref_id ?? `local:${it.foodId}`,
    // A component whose mass is unknown (t17) keeps null, never its card's placeholder total.
    grams: it.massUnknown ? (it.items?.[0]?.grams ?? null) : it.grams,
    qty: it.qty,
    unit: it.items?.[0]?.unit ?? "portion",
    snapshot: it.items?.[0]?.snapshot ?? {},
    foodId: it.foodId,
    name: it.name,
    portionLabel: it.portionLabel,
    macros: it.macros,
  }));
}

/** The one entry a saved meal becomes, card and commit alike. */
export function mealCard(input: {
  entryId: string;
  at: Date;
  items: LoggedFood[];
  catalogItems: { entryId: string; itemId: string; unit: string }[];
  name: string;
  note: string;
}): LoggedFood {
  const { entryId, at, items, catalogItems } = input;
  const flags = [...new Set(items.flatMap((i) => i.flags ?? []))];
  const count = `${items.length} item${items.length === 1 ? "" : "s"}`;
  const lines = mealEntryItems(items, catalogItems);
  const mass = entryMass(lines);
  return {
    id: entryId,
    foodId: "meal",
    name: input.name.trim() || `Meal · ${count}`,
    portionLabel: count,
    qty: 1,
    grams: Math.round(mass.grams),
    ...(mass.massUnknown ? { massUnknown: true as const } : {}),
    macros: sumMacros(items),
    flags: flags.length ? flags : undefined,
    note: input.note.trim() || undefined,
    items: lines,
    at: at.toISOString(),
  };
}
