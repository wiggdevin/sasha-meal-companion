/**
 * `skip_slot` and `restore_slot`: skip one meal for one date, or bring it back.
 *
 * A skip is Today's own Clear (lib/plan/skip-override.ts): the card stays, empty, and its share
 * goes to the day's open meals. The coach emits it only after the person said yes to a skip it
 * offered with the numbers from `preview_skip` (lib/coach/prompt.ts), and the server drops a
 * skip_slot that is not that (lib/server/coach-turn/skip-gate.ts). Undo restores the slot's
 * previous override exactly.
 */

import { z } from "zod";
import { MEAL_SLOT_IDS, type SlotId } from "@/lib/coach/types";
import type { SlotOverride } from "@/lib/types";
import { groundedBaseSchema, LOCAL_DATE, localDate, type GroundedBase } from "@/lib/coach/actions/fields";
import { dayLabel, slotName } from "@/lib/coach/actions/copy";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

type MealSlot = (typeof MEAL_SLOT_IDS)[number];
type Kind = "skip_slot" | "restore_slot";

const inputFor = <K extends Kind>(kind: K) =>
  z.object({ kind: z.literal(kind), date: localDate(), slot: z.enum(MEAL_SLOT_IDS) });

/** What Undo puts back: the override before, and the one this action wrote (to see a later edit). */
export type SkipUndoToken<K extends Kind> = {
  kind: K; date: string; slot: SlotId; previous: SlotOverride | null; applied: SlotOverride | null;
};

type Types<K extends Kind> = {
  kind: K;
  input: { kind: K; date: string; slot: MealSlot };
  action: GroundedBase & { kind: K; date: string; slot: MealSlot };
  token: SkipUndoToken<K>;
};

const replayFor = <K extends Kind>(kind: K) => z.object({ ...groundedBaseSchema,
  kind: z.literal(kind), date: z.string().regex(LOCAL_DATE), slot: z.enum(MEAL_SLOT_IDS) });

export const skipSlot: ActionSpec<Types<"skip_slot">> = {
  kind: "skip_slot",
  input: inputFor("skip_slot"),
  wire: { named: ["date", "slot"] },
  replay: replayFor("skip_slot"),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.slot} on ${action.date}`,
  prompt: { rank: 45, lines: [
    "  skip_slot { date, slot } skips one meal on one date; its share moves to the open meals.",
    "    ONLY after the person said yes to a skip offered with preview_skip's numbers. restore_slot",
    "    { date, slot } brings a skipped meal back.",
  ] },
  example: { rank: 95, lines: (ctx) => [
    '  User: "I\'ll be at the office tonight, a couple of gummy worms then crash. I\'ll eat tomorrow."',
    "  After preview_skip for the dinner slot, offer the skip with its choices and log nothing yet:",
    '  { "kind": "tool", "calls": [{ "name": "quick_replies", "args": { "options": ["Skip and rebalance", "Leave my plan"] } }] }',
    '  Final: { "kind": "final", "text": "Eating less on a busy day is fine, and tomorrow starts fresh. Want me to skip Meal 5 and log the gummy worms? Its ~520 kcal would move into Meal 4, which becomes ~900 kcal.", "actions": [] }',
    '  User: "Skip and rebalance, and log 2 gummy worms"',
    `  Final: { "kind": "final", "text": "Skipped Meal 5 and logged 2 gummy worms, 10 g.", "actions": [{ "kind": "skip_slot", "date": "${ctx.today}", "slot": "meal-5" }, { "kind": "log_meal", "date": "${ctx.today}", "slot": "snack", "title": "Gummy worms", "items": [{ "name": "gummy worms", "grams": 10 }] }] }`,
  ] },
  card: {
    title: (action) => `Skipped ${slotName(action.slot)} on ${dayLabel(action.date)}`,
    pending: (action) => `Skipping ${slotName(action.slot)} on ${dayLabel(action.date)}`,
  },
};

export const restoreSlot: ActionSpec<Types<"restore_slot">> = {
  kind: "restore_slot",
  input: inputFor("restore_slot"),
  wire: { named: ["date", "slot"] },
  replay: replayFor("restore_slot"),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.slot} on ${action.date}`,
  card: {
    title: (action) => `Brought back ${slotName(action.slot)} on ${dayLabel(action.date)}`,
    pending: (action) => `Bringing back ${slotName(action.slot)} on ${dayLabel(action.date)}`,
  },
};
