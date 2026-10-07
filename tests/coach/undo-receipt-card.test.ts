/**
 * The Undo list's cards (docs/specs/coach-undo-receipt.md §6.5): a receipt card from the receipt
 * only, the generic card for every legacy record, and the serverUndoable rules (§5, §6.5).
 */
import { describe, expect, it } from "vitest";
import { genericCard, receiptCard, type ReceiptRow } from "@/lib/coach/undo-receipt-card";
import { isServerUndoable, receiptServerUndoable } from "@/lib/coach/undo-types";

const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000011";
const record = (kind: string, sourceCheck: string | null = "match") =>
  ({ kind, createdAt: "2026-10-05T12:00:00.000Z", sourceCheck });

function receipt(kind: string, applied: Record<string, unknown>, sourceCheck = "match"): ReceiptRow {
  return { id: "r1", action_id: "act-1", kind, source: { messageId: MESSAGE, cardIndex: 0 },
    source_check: sourceCheck, applied };
}

const meal = { entryId: "e1", date: "2026-10-05", slot: "meal-2", eatenAt: "2026-10-05T12:00:00Z", rev: 1,
  title: null, items: [{ itemId: "i1", foodRefId: "f1", name: "Eggs", grams: 100 },
    { itemId: "i2", foodRefId: "f2", name: null, grams: null }] };
const recipe = { recipeId: "r1", rev: 1, name: "Eggs on toast", revisionId: "v1",
  items: [{ seq: 0, foodRefId: "f1", name: "Eggs", grams: 120 }, { seq: 1, foodRefId: "f3", name: "Toast", grams: 40 }] };
const beef = { name: "beef mince", qty: 150, unit: "g", role: "protein", macros: {} };
const slot = { date: "2026-10-06", slot: "meal-3", rev: 4, before: null,
  after: { baseMealId: null, components: [beef, { name: "rice", qty: 1, unit: "cup", role: "carb", macros: {} }],
    mutationId: "m-1" } };

describe("receipt cards", () => {
  it("draws a logged meal from the receipt's stored items", () => {
    expect(receiptCard(record("log_meal"), receipt("log_meal", meal))).toEqual({
      type: "receipt", kind: "log_meal", title: "Logged meal 2 on Mon, Oct 5",
      lines: [{ name: "Eggs", grams: 100 }, { name: null, grams: null }], date: "2026-10-05",
      slot: "meal-2", messageId: MESSAGE, sourceCheck: "match", complete: true });
  });

  it("draws a saved recipe by its name, dated by the record", () => {
    expect(receiptCard(record("save_recipe"), receipt("save_recipe", recipe))).toMatchObject({
      title: 'Saved the recipe "Eggs on toast"', date: "2026-10-05", slot: null,
      lines: [{ name: "Eggs", grams: 120 }, { name: "Toast", grams: 40 }], complete: true });
  });

  it("draws a slot from its after foods; grams only for a component in grams", () => {
    expect(receiptCard(record("set_slot_meal"), receipt("set_slot_meal", slot))).toMatchObject({
      title: "Put Beef mince in meal 3 on Tue, Oct 6", date: "2026-10-06", slot: "meal-3",
      lines: [{ name: "beef mince", grams: 150 }, { name: "rice", grams: null }], complete: true });
    const titled = { ...slot, after: { ...slot.after, title: "Chilli" } };
    expect(receiptCard(record("set_slot_meal"), receipt("set_slot_meal", titled)))
      .toMatchObject({ title: "Put Chilli in meal 3 on Tue, Oct 6" });
  });

  it("E1: a mismatched source shows the written foods and no message", () => {
    const card = receiptCard(record("set_slot_meal", "mismatch"), receipt("set_slot_meal", slot, "mismatch"));
    expect(card).toMatchObject({ sourceCheck: "mismatch", messageId: null, complete: true,
      lines: [{ name: "beef mince", grams: 150 }, { name: "rice", grams: null }] });
    expect(receiptServerUndoable({ undoneAt: null, expired: false }, card)).toBe(false);
  });

  it("a receipt record with no receipt, or an unreadable one, is incomplete and never server-undoable", () => {
    for (const read of [null, receipt("save_recipe", recipe), receipt("log_meal", { date: "x" })]) {
      const card = receiptCard(record("log_meal"), read);
      expect(card).toEqual({ type: "receipt", kind: "log_meal", title: "Coach change", lines: [],
        date: "2026-10-05", slot: null, messageId: null, sourceCheck: "match", complete: false });
      expect(receiptServerUndoable({ undoneAt: null, expired: false }, card)).toBe(false);
    }
  });

  it("server-undoable only while open, unexpired, complete and matched", () => {
    const card = receiptCard(record("log_meal"), receipt("log_meal", meal));
    expect(receiptServerUndoable({ undoneAt: null, expired: false }, card)).toBe(true);
    expect(receiptServerUndoable({ undoneAt: "2026-10-05T13:00:00Z", expired: false }, card)).toBe(false);
    expect(receiptServerUndoable({ undoneAt: null, expired: true }, card)).toBe(false);
    const none = receiptCard(record("log_meal", "none"), receipt("log_meal", meal, "none"));
    expect(receiptServerUndoable({ undoneAt: null, expired: false }, none)).toBe(false);
    expect(receiptServerUndoable({ undoneAt: null, expired: false }, genericCard("log_meal"))).toBe(false);
  });
});

describe("legacy records", () => {
  it("get the generic card, whatever their kind", () => {
    for (const kind of ["log_meal", "set_slot_meal", "save_recipe", "log_water"]) {
      expect(genericCard(kind)).toEqual({ type: "generic", kind, title: "Coach change" });
    }
  });

  it("E2: a legacy save_recipe record is phone-only, even with its revision known", () => {
    expect(isServerUndoable("save_recipe", { kind: "save_recipe", recipeId: "r1", rev: 1 })).toBe(false);
    // The other legacy kinds keep today's rule.
    expect(isServerUndoable("log_meal", { date: "2026-10-05", entryId: "e1", baseRev: 3 })).toBe(true);
  });
});
