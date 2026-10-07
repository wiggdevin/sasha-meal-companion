/** `move_slot`: set one plan slot's clock time on one date. */

import { z } from "zod";
import { SLOT_IDS, type SlotId } from "@/lib/coach/types";
import type { FoodComponent, SlotOverride } from "@/lib/types";
import {
  CLOCK_TIME, clockTime, groundedBaseSchema, LOCAL_DATE, localDate, type GroundedBase, type PlanSlot,
} from "@/lib/coach/actions/fields";
import { slotName } from "@/lib/coach/actions/copy";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({
  kind: z.literal("move_slot"),
  date: localDate(),
  slot: z.enum(SLOT_IDS),
  time: clockTime(),
});

type Types = {
  kind: "move_slot";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "move_slot"; date: string; slot: PlanSlot; time: string };
  token: { kind: "move_slot"; date: string; slot: SlotId; baseMealId: string | null;
    planned: FoodComponent[]; previous: SlotOverride | null };
};

export const moveSlot: ActionSpec<Types> = {
  kind: "move_slot",
  input,
  wire: { named: ["date", "slot"], strings: ["time"], fields: { time: z.string() } },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("move_slot"),
    date: z.string().regex(LOCAL_DATE), slot: z.enum(SLOT_IDS),
    time: z.string().regex(CLOCK_TIME) }),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.slot} → ${action.time}`,
  // The line introduces move_entry too: the prompt text predates the per-kind split and is pinned
  // byte for byte (tests/coach/action-golden).
  prompt: { rank: 40, lines: [
    "  move_slot { date, slot, stringArgs: [time] } changes a slot time; move_entry uses",
    "    { entryId, stringArgs: [at] } for an entry time.",
  ] },
  card: { title: (action) => `Moved ${slotName(action.slot)} to ${action.time}` },
};
