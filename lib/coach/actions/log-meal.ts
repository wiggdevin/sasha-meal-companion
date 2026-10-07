/**
 * `log_meal`: a meal the user already ate lands as one entry. Off-plan foods are marked, never
 * refused (ruling 2026-09-14). A snack lands outside the seven fixed slots.
 */

import { z } from "zod";
import { deriveMealTitle } from "@/lib/coach/meal-title";
import {
  actionItem, CLOCK_TIME, clockTime, groundedActionItemSchema, groundedBaseSchema, LOCAL_DATE,
  localDate, LOG_SLOT_IDS, mealTitle, withDerivedTitle,
  type GroundedActionItem, type GroundedBase, type LogSlot,
} from "@/lib/coach/actions/fields";
import { itemLine, slotName } from "@/lib/coach/actions/copy";
import { act, clarify, flagged, groundItems } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({
  kind: z.literal("log_meal"),
  date: localDate(),
  slot: z.enum(LOG_SLOT_IDS),
  title: mealTitle.optional(),
  items: z.array(actionItem).min(1).max(8),
  note: z.string().max(2000).optional(),
  /** The clock time the user said, in THEIR timezone. Absent means the slot's planned time. */
  at: clockTime().optional(),
});
type Input = z.infer<typeof input>;

export const logMeal: ActionSpec<{
  kind: "log_meal";
  input: Input;
  loose: Omit<Input, "title"> & { title?: string };
  action: GroundedBase & { kind: "log_meal"; date: string; slot: LogSlot; title?: string;
    items: GroundedActionItem[]; note?: string; at?: string };
  /**
   * `eatenAt` is the instant the entry was logged for (the tap, for a composed card's Log it); the
   * server's Undo deletes only the entry stored with exactly that instant and date.
   */
  token: { kind: "log_meal"; date: string; entryId: string; baseRev: number | null; eatenAt?: string };
}> = {
  kind: "log_meal",
  input,
  wire: { named: ["date", "slot", "title", "items"], strings: ["at", "note"],
    fields: { note: z.string().max(2000), at: z.string() },
    stringsDoc: ", using an empty at placeholder for note-only logs" },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("log_meal"),
    date: z.string().regex(LOCAL_DATE), slot: z.enum(LOG_SLOT_IDS),
    title: mealTitle,
    items: z.array(groundedActionItemSchema).min(1).max(8), note: z.string().max(2000).optional(),
    at: z.string().regex(CLOCK_TIME).optional() }),
  normalizeReplay: withDerivedTitle,
  ground: async (rawInput, kit) => {
    const derivedTitle = rawInput.title ?? deriveMealTitle(rawInput.items);
    if (!derivedTitle) return clarify("What should I call that meal?");
    const value = { ...rawInput, title: derivedTitle };
    const grounded = await groundItems(kit, value.items);
    if ("missing" in grounded) return clarify(...grounded.missing);
    const { items } = grounded;
    return act((actionId) => ({ ...value, actionId, flagged: flagged(items), items }));
  },
  history: (action) => ` ${action.slot}${action.at ? ` at ${action.at}` : ""}`
    + ` → ${action.items.map(itemLine).join(", ")}`,
  prompt: { rank: 10, lines: [
    "  log_meal { date, slot, title, items, stringArgs: [at, note] } — you ate it. `slot` is a",
    "    plan slot, or \"snack\" outside the plan. `at` is HH:MM on YOUR clock. Put it first when",
    "    you say a time; emit [\"\", note] when there is no time. Use [] only when both are absent.",
    // Production (2026-09-16..24): "Logged 200 g drunken noodles... as a snack" and a breakfast
    // food landed "as a snack" too — with no slot named, the model picked "snack" by default.
    "    With no slot named, use the planned slot closest to the time you say you ate (or now, with",
    "    no time given) — never \"snack\" by default. \"snack\" is only for food that is clearly a",
    "    snack or falls outside every planned meal window.",
  ] },
  card: {
    title: (action) => {
      if (action.slot.startsWith("meal-")) return `Logged ${slotName(action.slot)}`;
      if (action.slot === "snack") return `Logged a snack${action.at ? ` at ${action.at}` : ""}`;
      return `Logged ${slotName(action.slot)}`;
    },
    lines: (action) => action.items,
    macroItems: (action) => action.items,
  },
};
