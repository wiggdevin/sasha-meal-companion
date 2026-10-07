/** `set_targets`: pin a training-day, rest-day or both-days calorie or protein target. */

import { z } from "zod";
import { describedEnum, groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { displayName } from "@/lib/coach/actions/copy";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import type { SettingsToken } from "@/lib/coach/actions/update-profile";

const fields = () => ({
  dayType: z.enum(["training", "rest", "both"]),
  kcal: z.number().int().min(1000).max(5000).nullable().optional(),
  proteinG: z.number().int().min(50).max(300).nullable().optional(),
});

const input = z.object({ kind: z.literal("set_targets"), ...fields() })
  .refine((value) => value.kcal !== undefined || value.proteinG !== undefined,
    "kcal or proteinG is required");

type Types = {
  kind: "set_targets";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "set_targets"; dayType: "training" | "rest" | "both";
    kcal?: number | null; proteinG?: number | null };
  token: SettingsToken<"set_targets">;
};

export const setTargets: ActionSpec<Types> = {
  kind: "set_targets",
  input,
  wire: { named: [], numbers: ["kcal", "proteinG"], strings: ["dayType"],
    keepNull: ["kcal", "proteinG"],
    fields: { dayType: describedEnum(["training", "rest", "both"]),
      kcal: z.number().int().min(0).max(5000).nullable(),
      proteinG: z.number().int().min(0).max(300).nullable() } },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("set_targets"), ...fields() }),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.dayType}${action.kcal ? ` ${action.kcal} kcal` : ""}`
    + `${action.proteinG ? ` ${action.proteinG} g protein` : ""}`,
  prompt: { rank: 90, lines: [
    "  set_targets uses numericArgs [kcal, proteinG] and stringArgs [dayType]. Use 0 for an",
    "    unnamed numeric target; pin only the targets you explicitly asked to set.",
  ] },
  example: { rank: 60, lines: () => [
    '  User: "set my training day calories to 2300"',
    '  Final: { "kind": "final", "text": "Set training days to 2,300 kcal.", "actions": [{ "kind": "set_targets", "numericArgs": [2300, 0], "stringArgs": ["training"] }] }',
  ] },
  card: {
    title: (action) => {
      const day = action.dayType === "both" ? "Both days" : `${displayName(action.dayType)} day`;
      const values = [action.kcal == null ? null : `${action.kcal.toLocaleString()} kcal`,
        action.proteinG == null ? null : `${action.proteinG} g protein`]
        .filter((value): value is string => value !== null);
      return `${day} ${values.join(" · ")}`;
    },
  },
};
