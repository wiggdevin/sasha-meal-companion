/** `log_water`: water the user drank, added to that day's cups. */

import { z } from "zod";
import {
  groundedBaseSchema, LOCAL_DATE, localDate, type GroundedBase,
} from "@/lib/coach/actions/fields";
import { clarify, passThrough } from "@/lib/coach/actions/ground-kit";
import { cupsLabel, wholeCups } from "@/lib/water";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import {
  FAST_PATH_ARGUMENT_CONFIDENCE, measuredNumber, mlOf, type MissingArgs,
} from "@/lib/coach/intent-args";

const input = z.object({ kind: z.literal("log_water"),
  date: localDate().optional(),
  ml: z.number().int().min(1).max(3000) });

type Types = {
  kind: "log_water";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "log_water"; date?: string; ml: number };
  /**
   * Water is additive: Undo applies the exact inverse cup delta. `after` is the day's cups the add
   * left on this phone; the server's Undo runs only while the day still holds exactly that.
   */
  token: { kind: "log_water"; date: string; cups: number; after?: number; afterRev?: number };
  intentArgs: MissingArgs & { ml?: number };
};

export const logWater: ActionSpec<Types> = {
  kind: "log_water",
  input,
  wire: {
    named: ["date"],
    numbers: ["ml"],
    fields: { ml: z.number().int().min(0).max(3000) },
  },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("log_water"),
    date: z.string().regex(LOCAL_DATE).optional(), ml: z.number().int().min(1).max(3000) }),
  // A sip under half a cup rounds to 0 cups (lib/water.ts): ask, never promote it to a full cup.
  ground: async (action) => wholeCups(action.ml) === 0
    ? clarify(`That is under half a cup (about ${action.ml} ml), so I did not log it. Say "log 1 cup" if you want it counted.`)
    : passThrough(action),
  history: (action) => `${action.date ? ` ${action.date}` : ""} ${cupsLabel(wholeCups(action.ml))}`,
  // The line introduces log_weight too: the prompt text predates the per-kind split and is pinned
  // byte for byte (tests/coach/action-golden).
  prompt: { rank: 70, lines: [
    "  log_water { date?, numericArgs: [ml] } — water you drank. log_weight { date?,",
    "    numericArgs: [kg] } — your weigh-in.",
  ] },
  example: { rank: 30, lines: () => [
    '  User: "log 2 cups of water"',
    '  Final: { "kind": "final", "text": "Logged 2 cups (16 oz) of water.", "actions": [{ "kind": "log_water", "numericArgs": [480] }] }',
  ] },
  intent: {
    extract: ({ numbers, raw }) => {
      const measured = measuredNumber(["cup", "ml", "oz"], numbers, raw);
      const ml = mlOf(measured.candidate);
      const isMissing = ml === undefined || measured.confidence < FAST_PATH_ARGUMENT_CONFIDENCE;
      const argConfidence: Record<string, number> =
        ml === undefined ? {} : { ml: measured.confidence };
      return {
        args: { ...(ml === undefined ? {} : { ml }), ...(isMissing ? { missing: ["ml"] } : {}) },
        argConfidence,
      };
    },
  },
  fastPath: {
    candidate: (args) => args.ml === undefined || wholeCups(args.ml) === 0 ? null
      : { kind: "log_water", ml: Math.round(args.ml) },
    reply: (action) => `Logging ${cupsLabel(wholeCups(action.ml))} of water.`,
  },
  card: {
    title: (action) => `Logged ${cupsLabel(wholeCups(action.ml))} of water`,
    pending: (action) => `Logging ${cupsLabel(wholeCups(action.ml))} of water`,
  },
};
