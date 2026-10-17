/**
 * `set_slot_meal`: the WHOLE slot becomes these items on each selected date — one date, a range of
 * up to 31 calendar days, or chosen weekdays in it. A missing quantity takes the catalog's
 * household portion, or the usual serving for its kind when the row has none (`usualServing`).
 */

import { z } from "zod";
import { calendarDateRange, shiftCalendarDate } from "@/lib/dates/range";
import { deriveMealTitle } from "@/lib/coach/meal-title";
import { SLOT_IDS } from "@/lib/coach/types";
import {
  foodName, grams, groundedActionItemSchema, groundedBaseSchema, LOCAL_DATE, localDate, mealTitle,
  withDerivedTitle, type GroundedActionItem, type GroundedBase, type PlanSlot,
} from "@/lib/coach/actions/fields";
import { itemLine, slotName } from "@/lib/coach/actions/copy";
import { act, clarify, flagged, groundItems } from "@/lib/coach/actions/ground-kit";
import type { SlotUndoState } from "@/lib/coach/actions/slot-items";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({
  kind: z.literal("set_slot_meal"),
  from: localDate(),
  through: localDate(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  slot: z.enum(SLOT_IDS),
  title: mealTitle.optional(),
  // grams is OPTIONAL here and only here: a missing quantity falls back to the catalog's
  // household portion, else the usual serving for its kind (`usualServing`, ground-kit.ts).
  items: z.array(z.object({ name: foodName, grams: grams.optional() })).min(1).max(8),
});
type Input = z.infer<typeof input>;

/** Old single-date rows name `date`; the range contract names `from`/`through`. */
function normalizeRange(action: Record<string, unknown>): Record<string, unknown> {
  const from = action.from ?? action.date;
  return { ...action, from, through: action.through ?? from };
}

const RANGE_REASONS = {
  too_long: "I can plan at most 31 calendar days at once. Shorten the range and try again.",
  reversed: "The meal-plan end date must be on or after its start date.",
  invalid: "I could not read that meal-plan date range. Try the dates again.",
} as const;

type Action = GroundedBase & ({ kind: "set_slot_meal"; weekdays?: number[]; title?: string;
  slot: PlanSlot; items: GroundedActionItem[] } & (
  | { date: string; from?: string; through?: string; dates?: string[] }
  | { date?: string; from: string; through?: string; dates: string[] }
));

export const setSlotMeal: ActionSpec<{
  kind: "set_slot_meal";
  input: Input;
  /** Direct callers may still hand grounding the single-date alias. */
  loose: Omit<Input, "from" | "through" | "title">
    & { date?: string; from?: string; through?: string; title?: string };
  action: Action;
  token: { kind: "set_slot_meal" } & (SlotUndoState | { dates: SlotUndoState[] });
}> = {
  kind: "set_slot_meal",
  input,
  normalizeInput: normalizeRange,
  wire: { named: ["date", "from", "through", "weekdays", "slot", "title", "items"],
    // The live provider wire must name a set meal itself so a blank title causes a re-ask, not
    // silent derivation. Old stored rows use the strict schema directly and may derive one.
    candidate: (candidate, cleaned) => {
      if (cleaned.title === undefined) return null;
      return cleaned.from === undefined && cleaned.date !== undefined
        ? { ...candidate, from: cleaned.date } : candidate;
    } },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("set_slot_meal"),
    date: z.string().regex(LOCAL_DATE), from: z.string().regex(LOCAL_DATE),
    through: z.string().regex(LOCAL_DATE),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    dates: z.array(z.string().regex(LOCAL_DATE)).min(1).max(31), title: mealTitle,
    slot: z.enum(SLOT_IDS),
    items: z.array(groundedActionItemSchema).min(1).max(8) }),
  normalizeReplay: (value) => {
    const action = withDerivedTitle(normalizeRange(value));
    const from = action.from ?? action.date;
    return { ...action, date: action.date ?? from, from, through: action.through ?? from,
      dates: action.dates ?? (typeof from === "string" ? [from] : undefined) };
  },
  ground: async (rawInput, kit) => {
    // Public callers may still carry the single-date alias. runTurn has already schema-parsed its
    // inputs; this normalization keeps direct port-level callers backward compatible too.
    const derivedTitle = rawInput.title ?? deriveMealTitle(rawInput.items);
    if (!derivedTitle) return clarify("What should I call that meal?");
    const value = { ...rawInput, from: rawInput.from ?? rawInput.date!,
      through: rawInput.through ?? rawInput.from ?? rawInput.date!, title: derivedTitle };
    const grounded = await groundItems(kit, value.items);
    if ("missing" in grounded) return clarify(...grounded.missing);
    const { items } = grounded;
    // Keep `date` during the M1/M2 handoff: old phone code reads it while v2 code reads `dates`.
    return act((actionId) => ({ ...value, actionId, flagged: flagged(items),
      date: value.from, items }));
  },
  /** Food is grounded once, then plain local dates are expanded. */
  expand: (action) => {
    const from = action.from ?? action.date;
    if (!from) return { clarification: RANGE_REASONS.invalid };
    const through = action.through ?? from;
    const expanded = calendarDateRange(from, through, action.weekdays);
    if (!expanded.ok) return { clarification: RANGE_REASONS[expanded.reason] };
    if (expanded.dates.length === 0) {
      return { clarification: "That date range has none of the selected weekdays." };
    }
    return { action: { ...action, from, through, dates: expanded.dates } };
  },
  history: (action) => ` ${action.slot} → ${action.items.map(itemLine).join(", ")}`,
  prompt: { rank: 20, lines: [
    "  set_slot_meal { from, through?, weekdays?, slot, title, items } — the WHOLE slot becomes",
    "    these items on each selected date. `through` is inclusive and defaults to `from`; at most",
    "    31 calendar days. weekdays uses 0=Sunday through 6=Saturday after expansion.",
    "    The server fills `dates`; never write `dates`. Give grams when you do; otherwise use the catalog's",
    "    household portion, or a usual serving when it has none. Never ask how much.",
  ] },
  example: { rank: 90, lines: (ctx) => {
    const monthThrough = shiftCalendarDate(ctx.today, 30);
    const twoWeeksThrough = shiftCalendarDate(ctx.today, 13);
    return [
      '  User: "Change my 4th meal to tofu and rice"',
      "  COUNT the slots in YOUR DAY and take the 4th. Never assume a slot id — read it off YOUR DAY.",
      `  Final: { "kind": "final", "text": "Your 4th meal is tofu and rice now.", "actions": [{ "kind": "set_slot_meal", "from": "${ctx.today}", "slot": "<the 4th slot in YOUR DAY>", "title": "Tofu & rice", "items": [{ "name": "tofu", "grams": 150 }, { "name": "rice", "grams": 160 }] }] }`,
      '  User: "Set eggs as my breakfast for the next month"',
      `  Final action: { "kind": "set_slot_meal", "from": "${ctx.today}", "through": "${monthThrough}", "slot": "meal-1", "title": "Eggs", "items": [{ "name": "eggs", "grams": 200 }] }`,
      '  User: "Set oatmeal with blueberries for breakfast every weekday for two weeks"',
      `  Final action: { "kind": "set_slot_meal", "from": "${ctx.today}", "through": "${twoWeeksThrough}", "weekdays": [1, 2, 3, 4, 5], "slot": "meal-1", "title": "Oatmeal with blueberries", "items": [{ "name": "oatmeal" }, { "name": "blueberries" }] }`,
    ];
  } },
  card: {
    title: (action) => `Changed ${slotName(action.slot)}`,
    lines: (action) => action.items,
    macroItems: (action) => action.items,
  },
};
