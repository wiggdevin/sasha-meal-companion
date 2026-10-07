"use client";

/** The plan-slot half of a coach action: edit a slot, move a slot, and undo either. T6 §6. */

import type { CoachAction } from "@/lib/coach/actions";
import { deriveMealTitle, sanitizeMealTitle } from "@/lib/coach/meal-title";
import { completeComponentFromCatalog } from "@/lib/plan/catalog-component";
import { addComponent, removeComponent, replaceComponent }
  from "@/lib/plan/slot-override";
import { saveMealEdit } from "@/lib/plan-day-client";
import {
  amountReason, componentFor, componentsFor, incompleteReason, matchIndex, mealName, per100g, sameComponent, sameComponents, slotContext,
  type ApplyResult, type SlotItemEdit, type SlotUndoState, type UndoToken,
} from "@/lib/coach/apply-shared";
import type { FoodComponent } from "@/lib/types";
import {
  AccountChanged, accountHandle, assertCurrent, type AccountHandle,
} from "@/lib/device/account";

type SlotItemAction = Extract<CoachAction,
  { kind: "add_slot_item" | "remove_slot_item" | "set_slot_item" }>;
type SetSlotMealAction = Extract<CoachAction, { kind: "set_slot_meal" }>;

export async function applySlot(action: SlotItemAction): Promise<ApplyResult> {
  const context = slotContext(action.date, action.slot);
  if (!context) return { status: "failed", reason: `No ${action.slot} was found on that date.` };
  let components: FoodComponent[];
  let edit: SlotItemEdit;
  if (action.kind === "add_slot_item") {
    const badAmount = amountReason(action.item.name, action.item.grams);
    if (badAmount) return { status: "failed", reason: badAmount };
    const added = componentFor(action.item);
    if (!added) return { status: "failed", reason: incompleteReason(action.item.name) };
    components = addComponent(context.components, added);
    edit = { op: "add", component: added };
  } else {
    const match = matchIndex(context.components, action.name);
    if (!("index" in match)) {
      return { status: "failed", reason: match.reason === "ambiguous"
        ? `More than one line matches ${action.name}.`
        : `Could not find a matching line for ${action.name}.` };
    }
    const { index } = match;
    if (action.kind === "remove_slot_item") {
      components = removeComponent(context.components, index);
      edit = { op: "remove", index, component: context.components[index] };
    } else {
      const current = context.components[index];
      const badAmount = amountReason(current.name, action.grams);
      if (badAmount) return { status: "failed", reason: badAmount };
      // Built at the asked grams, so every macro is rounded once (a line built at 100 g and then
      // rescaled rounds twice: 0.04 g fat per 100 g over 250 g became 0).
      const grounded = completeComponentFromCatalog(current.name, per100g(action), action.grams);
      if (!grounded) return { status: "failed", reason: incompleteReason(current.name) };
      const changed: FoodComponent = { ...grounded, role: current.role };
      components = replaceComponent(context.components, index, changed);
      edit = { op: "set", index, before: current, after: changed };
    }
  }
  // saveMealEdit saves the store and queues the existing plan_days sync op; no new bus is needed.
  await saveMealEdit(action.date, action.slot, context.baseMealId,
    { planned: context.planned, components });
  return { status: "applied", token: { kind: action.kind, date: action.date, slot: action.slot,
    baseMealId: context.baseMealId, planned: context.planned, previous: context.previous,
    applied: components, edit } };
}

/**
 * "Change my 4th meal to beef jerky and a Chobani yogurt" — the WHOLE slot becomes the named
 * items. The same `saveMealEdit` override path a hand edit uses, so Undo is the previous override.
 */
export async function applySetSlotMeal(
  action: SetSlotMealAction,
): Promise<ApplyResult> {
  const dates = [...new Set(action.dates ?? [action.from ?? action.date].filter(
    (date): date is string => typeof date === "string"))];
  if (dates.length === 0 || dates.length > 31) {
    return { status: "failed", reason: "A meal series must contain between 1 and 31 dates." };
  }
  const lines = componentsFor(action.items);
  if (!lines.ok) return { status: "failed", reason: lines.reason };
  const components = lines.components;
  const title = action.title ? sanitizeMealTitle(action.title) : deriveMealTitle(action.items);
  if (!title) return { status: "failed", reason: "That meal needs a dish name." };
  // PR #248 review r4 #1: one date per await; each write only while the starting account is bound.
  const h = accountHandle();
  const written: SlotUndoState[] = [];
  try {
    for (const date of dates) {
      assertCurrent(h);
      const context = slotContext(date, action.slot);
      if (!context) throw new Error(`No ${action.slot} was found on ${date}.`);
      await saveMealEdit(date, action.slot, context.baseMealId,
        { planned: context.planned, components, title });
      written.push({ date, slot: action.slot, baseMealId: context.baseMealId,
        planned: context.planned, previous: context.previous, applied: components });
    }
  } catch (error) {
    if (error instanceof AccountChanged) throw error; // no rollback under another account
    // Rolling back this same apply: the slots hold what it just wrote, so restore unguarded.
    const failures = await restoreFailures(written, h, restoreSnapshot);
    if (failures.length > 0 && error instanceof Error) {
      const dates = failures.map((failure) => failure.date).join(", ");
      error.message = `${error.message} Restore also failed for: ${dates}.`;
      const cause = failures.length === 1 ? failures[0].error
        : new AggregateError(failures.map((failure) => failure.error), "Several restores failed.");
      Object.defineProperty(error, "cause", { value: cause, configurable: true });
    }
    throw error;
  }
  return { status: "applied", token: { kind: "set_slot_meal", dates: written } };
}

export async function applyMove(action: Extract<CoachAction, { kind: "move_slot" }>)
  : Promise<ApplyResult> {
  const context = slotContext(action.date, action.slot);
  if (!context) return { status: "failed", reason: `No ${action.slot} was found on that date.` };
  await saveMealEdit(action.date, action.slot, context.baseMealId,
    { planned: context.planned, time: action.time });
  return { status: "applied", token: { kind: "move_slot", date: action.date, slot: action.slot,
    baseMealId: context.baseMealId, planned: context.planned, previous: context.previous } };
}

export async function undoMove(token: Extract<UndoToken, { kind: "move_slot" }>): Promise<void> {
  await saveMealEdit(token.date, token.slot, token.previous?.baseMealId ?? token.baseMealId,
    { planned: token.planned, time: token.previous?.time ?? null });
}

export async function undoSlot(
  token: Extract<UndoToken, { kind: "add_slot_item" | "remove_slot_item" | "set_slot_item"
    | "set_slot_meal" }>,
): Promise<void> {
  if (token.kind === "set_slot_meal" && "dates" in token) {
    await restoreSlots(token.dates, accountHandle());
    return;
  }
  if (token.kind === "set_slot_meal") {
    await restoreSlot(token, true);
    return;
  }
  await undoSlotItem(token);
}

/**
 * Each card has its own Undo, in any order, so an undo inverts only its own line against the slot
 * as it is NOW. While the slot still holds exactly what the action wrote, the snapshot is restored
 * (that keeps "follow the plan"). A token minted before `applied`/`edit` existed restores the
 * snapshot as it always did.
 */
async function undoSlotItem(
  token: Extract<UndoToken, { kind: "add_slot_item" | "remove_slot_item" | "set_slot_item" }>,
): Promise<void> {
  if (!token.applied || !token.edit) {
    await restoreSnapshot(token, false);
    return;
  }
  const context = slotContext(token.date, token.slot);
  if (!context) throw new Error(`No ${mealName(token.slot)} was found on ${token.date}.`);
  if (sameComponents(context.components, token.applied)) {
    await restoreSnapshot(token, false);
    return;
  }
  const components = invertEdit(context.components, token.edit);
  if (!components) {
    const name = token.edit.op === "set" ? token.edit.after.name : token.edit.component.name;
    throw new Error(`${name} has changed since, so Undo left ${mealName(token.slot)} alone.`);
  }
  const followPlan = sameComponents(components, context.planned)
    && (token.previous === null || token.previous.followPlan === true)
    && context.previous?.title === undefined;
  await saveMealEdit(token.date, token.slot, context.baseMealId,
    { planned: context.planned, components: followPlan ? null : components });
}

/** The current lines with one edit reversed, or null when the line it touched has changed. */
function invertEdit(components: FoodComponent[], edit: SlotItemEdit): FoodComponent[] | null {
  if (edit.op === "remove") {
    const at = Math.min(edit.index, components.length);
    return [...components.slice(0, at), edit.component, ...components.slice(at)];
  }
  const target = edit.op === "add" ? edit.component : edit.after;
  const preferred = edit.op === "set" ? edit.index : -1;
  const index = preferred >= 0 && preferred < components.length
    && sameComponent(components[preferred], target)
    ? preferred : components.findLastIndex((component) => sameComponent(component, target));
  if (index < 0) return null;
  return edit.op === "add" ? removeComponent(components, index)
    : replaceComponent(components, index, edit.before);
}

/** A whole-meal swap undoes only while the slot still holds what the swap wrote. */
async function restoreSlot(token: SlotUndoState, restoreTitle: boolean): Promise<void> {
  if (token.applied) {
    const context = slotContext(token.date, token.slot);
    if (!context || !sameComponents(context.components, token.applied)) {
      throw new Error(`${mealName(token.slot)} has changed since, so Undo left it alone.`);
    }
  }
  await restoreSnapshot(token, restoreTitle);
}

async function restoreSnapshot(token: SlotUndoState, restoreTitle: boolean): Promise<void> {
  const components = token.previous === null || token.previous.followPlan
    ? null : token.previous.components;
  await saveMealEdit(token.date, token.slot, token.previous?.baseMealId ?? token.baseMealId,
    { planned: token.planned, components,
      ...(restoreTitle ? { title: token.previous?.title ?? null } : {}) });
}

async function restoreSlots(tokens: SlotUndoState[], h: AccountHandle): Promise<void> {
  const failures = await restoreFailures(tokens, h, restoreSlot);
  if (failures.length === 0) return;
  const dates = failures.map((failure) => failure.date).join(", ");
  const cause = failures.length === 1 ? failures[0].error
    : new AggregateError(failures.map((failure) => failure.error), "Several restores failed.");
  throw new Error(`Could not restore dates: ${dates}.`, { cause });
}

async function restoreFailures(
  tokens: SlotUndoState[], h: AccountHandle,
  restore: (token: SlotUndoState, restoreTitle: boolean) => Promise<void>,
): Promise<{ date: string; error: unknown }[]> {
  const failures: { date: string; error: unknown }[] = [];
  for (const token of [...tokens].reverse()) {
    assertCurrent(h); // outside the try: an account change stops the loop, it is not a failure
    try { await restore(token, true); }
    catch (error) { failures.push({ date: token.date, error }); }
  }
  return failures;
}
