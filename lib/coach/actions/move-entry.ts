/** `move_entry`: change the clock time of one logged entry. */

import { z } from "zod";
import { CLOCK_TIME, clockTime, groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { act, clarify, knownEntry } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const input = z.object({
  kind: z.literal("move_entry"), entryId: z.uuid(),
  at: clockTime(),
});

type Types = {
  kind: "move_entry";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "move_entry"; entryId: string; at: string; what: string };
  token: { kind: "move_entry"; date: string; entryId: string; previousAt: string };
};

export const moveEntry: ActionSpec<Types> = {
  kind: "move_entry",
  input,
  wire: { named: ["entryId"], strings: ["at"], fields: { at: z.string() } },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("move_entry"),
    entryId: z.uuid(), at: z.string().regex(CLOCK_TIME), what: z.string().max(200) }),
  ground: async (value, kit) => {
    const entry = await knownEntry(kit, value.entryId);
    if ("clarification" in entry) return clarify(entry.clarification);
    return act((actionId) => ({ ...value, what: entry.what, actionId, flagged: [] }));
  },
  history: (action) => ` ${action.entryId} ${action.what} → ${action.at}`,
  // Its prompt line is move_slot's, which introduces both.
  example: { rank: 110, lines: () => [
    '  User: "move it to 1:30"',
    '  Final: { "kind": "final", "text": "Moved to 13:30.", "actions": [{ "kind": "move_entry", "entryId": "<the id from YOUR DAY>", "stringArgs": ["13:30"] }] }',
  ] },
  card: { title: (action) => `Moved ${action.what} to ${action.at}` },
};
