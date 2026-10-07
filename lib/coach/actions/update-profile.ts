/** `update_profile`: the body, activity and goal fields the user named, and nothing else. */

import { z } from "zod";
import type { BodyFatSource, Settings } from "@/lib/types";
import { describedEnum, groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";

const SEX = ["female", "male"] as const;
const ACTIVITY = ["sedentary", "light", "moderate", "active", "very_active"] as const;
const GOAL = ["lose_fat", "recomp", "maintain", "gain_muscle"] as const;

const fields = () => ({
  heightCm: z.number().min(50).max(260).optional(),
  weightKg: z.number().min(20).max(400).optional(),
  birthYear: z.number().int().min(1900).max(new Date().getFullYear()).optional(),
  sex: z.enum(SEX).optional(),
  bodyFatPct: z.number().min(3).max(70).optional(),
  activityLevel: z.enum(ACTIVITY).optional(),
  goal: z.enum(GOAL).optional(),
  goalRateBpWeek: z.number().int().optional(),
  trainingWeekdays: z.array(z.number().int().min(0).max(6)).optional(),
});

const input = z.object({ kind: z.literal("update_profile"), ...fields() })
  .refine((value) => Object.keys(value).some((key) => key !== "kind"),
    "at least one profile field is required");

/** Profile and target pins share one Undo: put back the fields the write touched. */
export type SettingsToken<K extends "update_profile" | "set_targets"> = {
  kind: K; previous: Settings; fields: (keyof Settings)[];
};

type Types = {
  kind: "update_profile";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "update_profile"; heightCm?: number; weightKg?: number;
    birthYear?: number; sex?: "female" | "male"; bodyFatPct?: number;
    /** Settings' source picker only (step C); the coach never proposes a scan. */
    bodyFatSource?: BodyFatSource | null; bodyFatMeasuredOn?: string | null;
    activityLevel?: "sedentary" | "light" | "moderate" | "active" | "very_active";
    goal?: "lose_fat" | "recomp" | "maintain" | "gain_muscle";
    trainingWeekdays?: number[] };
  token: SettingsToken<"update_profile">;
};

export const updateProfile: ActionSpec<Types> = {
  kind: "update_profile",
  input,
  wire: {
    named: [],
    numbers: ["heightCm", "weightKg", "birthYear", "bodyFatPct"],
    numbersRest: { field: "trainingWeekdays", max: 7 },
    numbersDoc: " with zero placeholders",
    strings: ["sex", "activityLevel", "goal"],
    stringsDoc: " with empty placeholders",
    fields: {
      heightCm: z.number().min(0).max(260),
      weightKg: z.number().min(0).max(400),
      birthYear: z.number().int().min(0).max(new Date().getFullYear()),
      sex: describedEnum(SEX),
      bodyFatPct: z.number().min(0).max(70),
      activityLevel: describedEnum(ACTIVITY),
      goal: describedEnum(GOAL),
      trainingWeekdays: z.array(z.number().int().min(0).max(6)),
    },
  },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("update_profile"), ...fields() }),
  ground: async (value) => passThrough(value),
  history: (action) => ` ${Object.keys(action)
    .filter((key) => !["kind", "actionId", "flagged"].includes(key)).join(", ")}`,
  prompt: { rank: 80, lines: [
    "  update_profile uses numericArgs [heightCm, weightKg, birthYear, bodyFatPct,",
    "    ...trainingWeekdays] and stringArgs [sex, activityLevel, goal]. Use 0 and empty-string",
    "    placeholders for unnamed earlier positions; update only the fields you named.",
  ] },
  example: { rank: 50, lines: (ctx) => [
    '  User: "I\'m 34 now"',
    `  Final: { "kind": "final", "text": "Updated your birth year.", "actions": [{ "kind": "update_profile", "numericArgs": [0, 0, ${Number(ctx.today.slice(0, 4)) - 34}] }] }`,
  ] },
  card: { title: () => "Profile updated" },
};
