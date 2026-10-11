/**
 * One line of a plan slot — `add_slot_item`, `remove_slot_item`, `set_slot_item`. They share the
 * slot context, one apply and one Undo that inverts only its own line, so they share one file.
 * The other items on the card are never resized (ruling 2026-09-14).
 */

import { z } from "zod";
import { SLOT_IDS, type SlotId } from "@/lib/coach/types";
import type { FoodComponent, SlotOverride } from "@/lib/types";
import {
  actionItem, foodName, grams, groundedActionItemSchema, groundedBaseSchema,
  groundedNamedFoodSchema, LOCAL_DATE, localDate,
  type GroundedActionItem, type GroundedBase, type GroundedNamedFood, type PlanSlot,
} from "@/lib/coach/actions/fields";
import { itemLine, slotName } from "@/lib/coach/actions/copy";
import {
  act, clarification, clarify, flagged, groundItems, groundNamedFood,
} from "@/lib/coach/actions/ground-kit";
import type { ActionSpec, GroundKit } from "@/lib/coach/actions/spec";

export type SlotUndoState = { date: string; slot: SlotId; baseMealId: string | null;
  planned: FoodComponent[]; previous: SlotOverride | null;
  /**
   * The components this action wrote. Undo restores `previous` only while the slot still holds
   * exactly these; otherwise a later edit exists and must survive. Absent on a token minted before
   * this existed — undo then restores `previous` as it always did.
   */
  applied?: FoodComponent[] };

/** The one line a slot-item action changed, so Undo can invert just that line. */
export type SlotItemEdit =
  | { op: "add"; component: FoodComponent }
  | { op: "remove"; index: number; component: FoodComponent }
  | { op: "set"; index: number; before: FoodComponent; after: FoodComponent };

type SlotItemKind = "add_slot_item" | "remove_slot_item" | "set_slot_item";
/** One token shape for all three: the apply writes whichever kind it was handed. */
type SlotItemToken = { kind: SlotItemKind; edit?: SlotItemEdit } & SlotUndoState;

const addInput = z.object({
  kind: z.literal("add_slot_item"),
  date: localDate(),
  slot: z.enum(SLOT_IDS),
  item: actionItem,
});
const removeInput = z.object({
  kind: z.literal("remove_slot_item"),
  date: localDate(),
  slot: z.enum(SLOT_IDS),
  name: foodName,
});
const setInput = z.object({
  kind: z.literal("set_slot_item"),
  date: localDate(),
  slot: z.enum(SLOT_IDS),
  name: foodName,
  grams,
});

export const addSlotItem: ActionSpec<{
  kind: "add_slot_item";
  input: z.infer<typeof addInput>;
  action: GroundedBase & { kind: "add_slot_item"; date: string; slot: PlanSlot;
    item: GroundedActionItem };
  token: SlotItemToken;
}> = {
  kind: "add_slot_item",
  input: addInput,
  wire: { named: ["date", "slot", "item"] },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("add_slot_item"),
    date: z.string().regex(LOCAL_DATE), slot: z.enum(SLOT_IDS), item: groundedActionItemSchema }),
  ground: async (input, kit) => {
    const grounded = await groundItems(kit, [input.item]);
    if ("missing" in grounded) return clarify(...grounded.missing);
    const { items } = grounded;
    return act((actionId) => ({ ...input, actionId, flagged: flagged(items), item: items[0] }));
  },
  history: (action) => ` ${action.slot} → ${itemLine(action.item)}`,
  // The one line introduces all three.
  prompt: { rank: 30, lines: [
    "  add_slot_item / remove_slot_item / set_slot_item — one line of a slot.",
  ] },
  card: {
    title: (action) => `Added to ${slotName(action.slot)}`,
    lines: (action) => [action.item],
    macroItems: (action) => [action.item],
  },
};

/** A named line of the slot, grounded so the card and Undo know the food. */
async function groundNamedLine<I extends { name: string }>(
  input: I, itemGrams: number | null, kit: GroundKit,
) {
  const food = await groundNamedFood(kit.userId, input.name, itemGrams, kit.profile, kit.ports);
  if (food === null) return clarify<I & GroundedNamedFood & GroundedBase>(clarification(input.name));
  return act((actionId) => ({ ...input, ...food, actionId, flagged: flagged([food]) }));
}

export const removeSlotItem: ActionSpec<{
  kind: "remove_slot_item";
  input: z.infer<typeof removeInput>;
  action: GroundedBase & { kind: "remove_slot_item"; date: string; slot: PlanSlot }
    & GroundedNamedFood;
  token: SlotItemToken;
}> = {
  kind: "remove_slot_item",
  input: removeInput,
  wire: { named: ["date", "slot", "name"] },
  replay: groundedNamedFoodSchema.extend({ ...groundedBaseSchema, kind: z.literal("remove_slot_item"),
    date: z.string().regex(LOCAL_DATE), slot: z.enum(SLOT_IDS) }),
  ground: (input, kit) => groundNamedLine(input, null, kit),
  history: (action) => ` ${action.slot} → ${action.name}`,
  card: {
    title: (action) => `Removed ${action.name} from ${slotName(action.slot)}`,
    lines: (action) => [{ name: action.name, grams: null }],
  },
};

export const setSlotItem: ActionSpec<{
  kind: "set_slot_item";
  input: z.infer<typeof setInput>;
  action: GroundedBase & { kind: "set_slot_item"; date: string; slot: PlanSlot; grams: number }
    & GroundedNamedFood;
  token: SlotItemToken;
}> = {
  kind: "set_slot_item",
  input: setInput,
  wire: { named: ["date", "slot", "name", "grams"] },
  replay: groundedNamedFoodSchema.extend({ ...groundedBaseSchema, kind: z.literal("set_slot_item"),
    date: z.string().regex(LOCAL_DATE), slot: z.enum(SLOT_IDS), grams }),
  ground: (input, kit) => groundNamedLine(input, input.grams, kit),
  history: (action) => ` ${action.slot} → ${action.name} ${Math.round(action.grams)} g`,
  card: {
    title: (action) => `Changed ${action.name} to ${action.grams} g`,
    lines: (action) => [{ name: action.name, grams: action.grams }],
    // No macro strip: the grounded row is a search for the model's word, not the line's own food,
    // whose numbers the apply scales (audit 2026-10-10 A158).
  },
};
