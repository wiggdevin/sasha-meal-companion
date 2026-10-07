/** `delete_entry`: take one logged entry off the day; Undo puts the same entry back. */

import { z } from "zod";
import type { SlotId } from "@/lib/coach/types";
import type { LoggedFood } from "@/lib/types";
import { groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { act, clarify, knownEntry } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({ kind: z.literal("delete_entry"), entryId: z.uuid() });

type Types = {
  kind: "delete_entry";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "delete_entry"; entryId: string; what: string };
  token: { kind: "delete_entry"; date: string; entry: LoggedFood & { tz?: string };
    /** The originals, so Undo restores them without inventing a snack time. */
    slot: SlotId | "snack"; eatenAt: string;
    /** `grams` null: an unknown mass (t17) — `qty`/`unit` are its amount and `perUnit` its own
     *  per-unit numbers, so Undo puts back a unit entry, never a 0 g one. */
    items: { foodRefId: string; grams: number | null; revisionId: number | null; name: string;
      qty?: number; unit?: string; perUnit?: Record<string, number> }[] };
};

export const deleteEntry: ActionSpec<Types> = {
  kind: "delete_entry",
  input,
  wire: { named: ["entryId"] },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("delete_entry"),
    entryId: z.uuid(), what: z.string().max(200) }),
  ground: async (value, kit) => {
    const entry = await knownEntry(kit, value.entryId);
    if ("clarification" in entry) return clarify(entry.clarification);
    return act((actionId) => ({ ...value, what: entry.what, actionId, flagged: [] }));
  },
  history: (action) => ` ${action.entryId} ${action.what}`,
  prompt: { rank: 60, lines: [
    "  delete_entry { entryId } — take a logged entry off the day. The id comes from YOUR DAY or",
    "    get_entries; never invent one.",
  ] },
  example: { rank: 100, lines: () => [
    '  User: "delete the eggs one" (its entryId is in YOUR DAY)',
    '  Final: { "kind": "final", "text": "That one is gone.", "actions": [{ "kind": "delete_entry", "entryId": "<the id from YOUR DAY>" }] }',
  ] },
  card: { title: (action) => `Deleted ${action.what}` },
};
