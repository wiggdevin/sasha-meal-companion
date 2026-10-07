/**
 * An uploaded plan's matched meal as the composed-meal shape composedActions reads, so "Use for
 * this meal" builds its set_slot_meal action exactly as "Put it in Meal N" does. Every item was
 * grounded and allowed on the server; nothing is added here. Pure, no I/O.
 */
import type { ComposedMeal } from "@/lib/coach/compose";
import { fitNote, fitsTarget } from "@/lib/coach/compose-size";
import type { DocumentMatch } from "@/lib/plan/document-types";
import type { Macros } from "@/lib/types";

const per = (value: number | null, grams: number) => Math.round((value ?? 0) * grams) / 100;

export function documentMeal(match: DocumentMatch, slot: string, target: Macros | undefined): ComposedMeal {
  const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const bar = target ?? zero;
  // The plan's own portions stand; whether they fit the slot is shown (the same 10 % bar a coach
  // card uses, lib/coach/compose-size.ts), not enforced here. With no slot target there is no bar.
  const fits = fitsTarget(match.totals, bar);
  return {
    wish: match.title, slot, flagged: [], totals: match.totals, target: bar,
    fitsTarget: fits, fitNote: fits ? null : fitNote(match.totals, bar),
    items: match.items.map((item) => ({
      name: item.name, foodRefId: item.foodRefId, catalogFoodRevisionId: item.catalogFoodRevisionId,
      grams: item.grams, kcalPer100g: item.kcalPer100g, proteinPer100g: item.proteinPer100g,
      carbsPer100g: item.carbsPer100g, fatPer100g: item.fatPer100g, verdict: item.verdict,
      macros: { kcal: per(item.kcalPer100g, item.grams), protein: per(item.proteinPer100g, item.grams),
        carbs: per(item.carbsPer100g, item.grams), fat: per(item.fatPer100g, item.grams) },
    })),
  };
}
