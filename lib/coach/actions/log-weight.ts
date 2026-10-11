/** `log_weight`: the user's weigh-in, which may also move a complete profile's targets. */

import { z } from "zod";
import {
  groundedBaseSchema, LOCAL_DATE, localDate, type GroundedBase,
} from "@/lib/coach/actions/fields";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import {
  addLocalDays, dayArgs, FAST_PATH_ARGUMENT_CONFIDENCE, kgOf, measuredNumber, type MissingArgs,
} from "@/lib/coach/intent-args";

const input = z.object({ kind: z.literal("log_weight"),
  date: localDate().optional(),
  kg: z.number().min(20).max(400) });

type Types = {
  kind: "log_weight";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "log_weight"; date?: string; kg: number };
  token: { kind: "log_weight"; date: string; previousLb: number | null; tz: string };
  intentArgs: MissingArgs & { kg?: number; dayOffset?: number };
};

export const logWeight: ActionSpec<Types> = {
  kind: "log_weight",
  input,
  wire: {
    named: ["date"],
    numbers: ["kg"],
    fields: { kg: z.number().min(0).max(400) },
  },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("log_weight"),
    date: z.string().regex(LOCAL_DATE).optional(), kg: z.number().min(20).max(400) }),
  ground: async (action) => passThrough(action),
  history: (action) => `${action.date ? ` ${action.date}` : ""} ${action.kg} kg`,
  // Its prompt line is log_water's, which introduces both.
  example: { rank: 40, lines: () => [
    '  User: "I weigh 128 lb"',
    '  Final: { "kind": "final", "text": "Logged 58.1 kg.", "actions": [{ "kind": "log_weight", "numericArgs": [58.1] }] }',
  ] },
  intent: {
    extract: ({ numbers, raw, message }) => {
      const measured = measuredNumber(["kg", "lb"], numbers, raw);
      const kg = kgOf(measured.candidate);
      // A stated day (A024): "yesterday" is read here; any other day takes the model turn.
      const day = dayArgs(message, [-1]);
      const missing = [
        ...(kg === undefined || measured.confidence < FAST_PATH_ARGUMENT_CONFIDENCE ? ["kg"] : []),
        ...(day.missing ?? []),
      ];
      const argConfidence: Record<string, number> =
        { ...(kg === undefined ? {} : { kg: measured.confidence }), ...day.argConfidence };
      return {
        args: { ...(kg === undefined ? {} : { kg }),
          ...(day.dayOffset === undefined ? {} : { dayOffset: day.dayOffset }),
          ...(missing.length ? { missing } : {}) },
        argConfidence,
      };
    },
  },
  fastPath: {
    candidate: (args, today) => args.kg === undefined ? null : { kind: "log_weight", kg: args.kg,
      ...(args.dayOffset ? { date: addLocalDays(today, args.dayOffset) } : {}) },
    reply: (action) => `Logging ${Math.round(action.kg * 10) / 10} kg.`,
  },
  card: {
    title: (action) => `Weight ${action.kg.toLocaleString()} kg`,
    pending: (action) => `Logging weight ${action.kg.toLocaleString()} kg`,
  },
};
