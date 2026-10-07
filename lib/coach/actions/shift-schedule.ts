/** `shift_schedule`: move one date's slots by signed minutes — all of them, or the uneaten ones. */

import { z } from "zod";
import type { SlotId } from "@/lib/coach/types";
import type { FoodComponent } from "@/lib/types";
import {
  describedEnum, groundedBaseSchema, LOCAL_DATE, localDate, type GroundedBase,
} from "@/lib/coach/actions/fields";
import { direction } from "@/lib/coach/actions/copy";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import {
  choiceConfidence, FAST_PATH_ARGUMENT_CONFIDENCE, measuredNumber, minutesOf, type MissingArgs,
} from "@/lib/coach/intent-args";

const minutes = () => z.number().int().min(-720).max(720).refine((value) => value !== 0);
const scope = () => z.enum(["all", "remaining"]);

const input = z.object({
  kind: z.literal("shift_schedule"),
  date: localDate(),
  minutes: minutes(),
  scope: scope(),
});

type Types = {
  kind: "shift_schedule";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "shift_schedule"; date: string; minutes: number;
    scope: "all" | "remaining" };
  token: { kind: "shift_schedule"; date: string; slots: {
    slot: SlotId; baseMealId: string | null; planned: FoodComponent[]; previousTime: string | null;
  }[] };
  intentArgs: MissingArgs & {
    minutes?: number;
    direction: "later" | "earlier";
    scope: "all" | "remaining" | "one_slot";
  };
};

export const shiftSchedule: ActionSpec<Types> = {
  kind: "shift_schedule",
  input,
  wire: { named: ["date"], numbers: ["minutes"], strings: ["scope"],
    fields: { minutes: z.number().int().min(-720).max(720),
      scope: describedEnum(["all", "remaining"]) } },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("shift_schedule"),
    date: z.string().regex(LOCAL_DATE), minutes: minutes(), scope: scope() }),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.date} ${action.minutes} min ${action.scope}`,
  prompt: { rank: 50, lines: [
    "  shift_schedule { date, numericArgs: [minutes], stringArgs: [scope] } — move that date's",
    "    slots by signed minutes. Use",
    "    scope remaining when you woke late or mean meals you have not eaten; all only when you",
    "    explicitly mean every slot. Name the new times in the reply.",
  ] },
  example: { rank: 20, lines: (ctx) => [
    '  User: "I woke up late, move all my meals by 30 minutes"',
    `  Final: { "kind": "final", "text": "Moved your remaining meals 30 minutes later. They are now at 13:30, 17:00 and 20:00.", "actions": [{ "kind": "shift_schedule", "date": "${ctx.today}", "numericArgs": [30], "stringArgs": ["remaining"] }] }`,
  ] },
  intent: {
    extract: ({ numbers, raw }) => {
      const measured = measuredNumber(["min", "hour"], numbers, raw);
      const minutes = minutesOf(measured.candidate);
      const missing: string[] = [];
      if (minutes === undefined || measured.confidence < FAST_PATH_ARGUMENT_CONFIDENCE) {
        missing.push("minutes");
      }
      if (raw.scope.choice === "one_slot") missing.push("slot");
      return {
        args: {
          ...(minutes === undefined ? {} : { minutes }),
          direction: raw.direction.choice,
          scope: raw.scope.choice,
          ...(missing.length ? { missing } : {}),
        },
        argConfidence: {
          ...(minutes === undefined ? {} : { minutes: measured.confidence }),
          direction: choiceConfidence(raw.direction),
          scope: choiceConfidence(raw.scope),
        },
      };
    },
  },
  fastPath: {
    candidate: (args, today) => {
      if (args.minutes === undefined || args.scope === "one_slot") return null;
      return {
        kind: "shift_schedule",
        date: today,
        minutes: args.direction === "earlier" ? -Math.abs(args.minutes) : Math.abs(args.minutes),
        scope: args.scope ?? "remaining",
      };
    },
    reply: (action) => `Moving your ${action.scope === "remaining" ? "remaining" : "planned"} meals `
      + `${Math.abs(action.minutes)} minutes ${action.minutes < 0 ? "earlier" : "later"}.`,
  },
  card: {
    title: (action) =>
      `Moved ${action.scope === "all" ? "all" : "remaining"} meals ${direction(action.minutes)}`,
    pending: (action) =>
      `Moving ${action.scope === "all" ? "all" : "remaining"} meals ${direction(action.minutes)}`,
  },
};
