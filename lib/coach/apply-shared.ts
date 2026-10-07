"use client";

/**
 * What every coach-action apply needs: the undo token union, the result shape, the macro helpers
 * and the tz-aware clock. Split out of lib/coach/apply-client.ts by T6 §6 so the per-kind apply
 * modules (apply-log, apply-slot, apply-prefs) share one definition instead of three.
 */

import type { ActionUndoToken, GroundedActionItem } from "@/lib/coach/actions";
import { MAX_ITEM_GRAMS } from "@/lib/coach/actions/fields";
import { completeComponentFromCatalog } from "@/lib/plan/catalog-component";
import { componentsForSlot } from "@/lib/plan/slot-override";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import type { FoodComponent, SlotId, SlotOverride, Store } from "@/lib/types";

export type SlotActionKind = "add_slot_item" | "remove_slot_item" | "set_slot_item";
export type { PrefBefore } from "@/lib/coach/actions/food-lists";
export type { SlotItemEdit, SlotUndoState } from "@/lib/coach/actions/slot-items";

/** Every kind's undo token, each declared in its spec (lib/coach/actions/<kind>.ts). */
export type UndoToken = ActionUndoToken;

/**
 * `nutritionUnchecked`: the log commit landed but its partial check could not run (the server's
 * `nutrition_unchecked`), so the card says "Saved. Nutrition not fully checked." once. Said for
 * this apply only; the remembered result drops it (lib/coach/apply-client.ts `remember`).
 */
export type ApplyResult =
  | { status: "applied"; token: UndoToken; notices?: string[]; nutritionUnchecked?: true }
  | { status: "failed"; reason: string };

/**
 * What an Undo can report besides "done" (t23 #8). `nutritionUnchecked`: only an Undo that commits
 * a log entry again (delete_entry puts the entry back) can say this, with the same meaning as on
 * ApplyResult. `already`: this tap found the action already undone — by an earlier tap (this phone
 * or another device) or discovered so when the server record was read — rather than undoing it
 * fresh just now; the card says "This was already undone." instead of "Undone."
 */
export type UndoOutcome = void | { nutritionUnchecked?: true; already?: true };

export type ApplyContext = {
  tz: string; now?: Date; fetchImpl?: typeof fetch;
  /** The action came from the deterministic no-Gemini path, for outcome telemetry only. */
  fastPath?: boolean;
  onSettled?: (result: ApplyResult) => void;
  /** The coach thread the action came from; narrows the server's undo record lookup. */
  threadId?: string | null;
  /**
   * For a composed meal card's button: the saved message holding the card and the card's index in
   * its `composed` list, so the server can record an action whose id was minted at the tap.
   */
  source?: { messageId: string; cardIndex: number };
};

export const round1 = (value: number) => Math.round(value * 10) / 10;

export type SlotContext = {
  baseMealId: string | null;
  components: FoodComponent[];
  planned: FoodComponent[];
  previous: SlotOverride | null;
};

function cloneOverride(override: SlotOverride | undefined): SlotOverride | null {
  if (!override) return null;
  return { ...override, components: override.components.map((component) => ({
    ...component, macros: { ...component.macros },
  })) };
}

function plannedStore(store: Store, date: string, slot: SlotId): Store {
  const day = store.days[date] ?? { date };
  const itemOverrides = { ...(day.itemOverrides ?? {}) };
  delete itemOverrides[slot];
  return { ...store, days: { ...store.days, [date]: { ...day, itemOverrides } } };
}

export function slotContext(date: string, slot: SlotId): SlotContext | null {
  const store = loadStore();
  const currentSlot = resolveDay(store, date).slots.find((row) => row.slot === slot);
  const plannedSlot = resolveDay(plannedStore(store, date, slot), date).slots
    .find((row) => row.slot === slot);
  if (!currentSlot || !plannedSlot) return null;
  const previous = cloneOverride(store.days[date]?.itemOverrides?.[slot]);
  return {
    baseMealId: currentSlot.meal?.id ?? null,
    components: componentsForSlot(plannedSlot.components, previous ?? undefined),
    planned: plannedSlot.components,
    previous,
  };
}

export function per100g(item: Pick<GroundedActionItem, "kcalPer100g" | "proteinPer100g" |
  "carbsPer100g" | "fatPer100g">): Record<string, number | null> {
  return {
    energy_kcal: item.kcalPer100g,
    protein: item.proteinPer100g,
    carbohydrate: item.carbsPer100g,
    fat_total: item.fatPer100g,
  };
}

/** The plan line for a grounded item, or null when its catalog row leaves a card number unknown. */
export function componentFor(item: GroundedActionItem): FoodComponent | null {
  return completeComponentFromCatalog(item.name, per100g(item), item.grams);
}

/**
 * Why an amount cannot be written, or null when it can: finite, above zero and at most
 * MAX_ITEM_GRAMS (the action schema's own bound). Every coach write checks it before it builds a
 * line, so a negative, NaN or infinite amount never becomes a 100 g line, a zero line or a
 * negative gram payload.
 */
export function amountReason(name: string, grams: unknown): string | null {
  return typeof grams === "number" && Number.isFinite(grams) && grams > 0 && grams <= MAX_ITEM_GRAMS ? null
    : `${name} needs an amount above 0 g and up to ${MAX_ITEM_GRAMS} g, so nothing was saved.`;
}

/** Every item's line, or the first item whose amount is invalid or nutrition incomplete (audit #20). */
export function componentsFor(items: readonly GroundedActionItem[]):
  { ok: true; components: FoodComponent[] } | { ok: false; reason: string } {
  const components: FoodComponent[] = [];
  for (const item of items) {
    const badAmount = amountReason(item.name, item.grams);
    if (badAmount) return { ok: false, reason: badAmount };
    const component = componentFor(item);
    if (!component) return { ok: false, reason: incompleteReason(item.name) };
    components.push(component);
  }
  return { ok: true, components };
}

export function incompleteReason(name: string): string {
  return `${name} has incomplete nutrition in the food database, so nothing was saved. Try another match.`;
}

export function revisionRef(revisionId: number | null): { revision_id: number | null } {
  return { revision_id: revisionId };
}

export function dateInZone(at: Date, tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(at);
  } catch { return null; }
}

/** Turn a calendar date and clock time in `tz` into the instant the log contract requires. */
export function instantAt(date: string, time: string, tz: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    for (let pass = 0; pass < 2; pass += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
      const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
      instant += target - shown;
    }
    const result = new Date(instant);
    return dateInZone(result, tz) === date ? result : null;
  } catch { return null; }
}

export function mealName(slot: SlotId | "snack"): string {
  if (slot.startsWith("meal-")) return slot.replace("meal-", "Meal ");
  if (slot === "hot-chocolate") return "Hot chocolate";
  if (slot === "post-refuel") return "Post-training refuel";
  if (slot === "pouches-pre") return "Pre-training carbs";
  if (slot === "snack") return "Snack";
  return "Coffee";
}

export function sum(items: FoodComponent[]): FoodComponent["macros"] {
  return items.reduce((total, item) => ({
    kcal: total.kcal + item.macros.kcal,
    protein: round1(total.protein + item.macros.protein),
    carbs: round1(total.carbs + item.macros.carbs),
    fat: round1(total.fat + item.macros.fat),
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

/** Two lines are the same line when every stored field matches; FoodComponent has no id. */
export function sameComponent(a: FoodComponent, b: FoodComponent): boolean {
  return a.name === b.name && a.qty === b.qty && a.unit === b.unit && a.role === b.role
    && a.macros.kcal === b.macros.kcal && a.macros.protein === b.macros.protein
    && a.macros.carbs === b.macros.carbs && a.macros.fat === b.macros.fat;
}

export function sameComponents(a: FoodComponent[], b: FoodComponent[]): boolean {
  return a.length === b.length && a.every((component, i) => sameComponent(component, b[i]));
}

export function matchIndex(components: FoodComponent[], name: string):
  { index: number } | { reason: "missing" | "ambiguous" } {
  const needle = name.trim().toLocaleLowerCase();
  const exact = components.flatMap((component, index) => (
    component.name.trim().toLocaleLowerCase() === needle ? [index] : []));
  if (exact.length === 1) return { index: exact[0] };
  if (exact.length > 1) return { reason: "ambiguous" };
  const partial = components.flatMap((component, index) => (
    component.name.toLocaleLowerCase().includes(needle) ? [index] : []));
  if (partial.length === 1) return { index: partial[0] };
  return { reason: partial.length === 0 ? "missing" : "ambiguous" };
}
