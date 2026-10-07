/**
 * The strict zod pieces more than one coach action kind is built from: dates, clock times, food
 * names and grams on the way in, and the grounded food shapes on the way back out. A kind's own
 * fields live in its spec file; only what several kinds share is here.
 *
 * Pure. No I/O, no Supabase import. Imports nothing from the registry.
 */

import { z } from "zod";
import { SAME_NAME_CAP } from "@/lib/foods/base-name";
import { SLOT_IDS } from "@/lib/coach/types";
import {
  policyMarkSchema, sanityAnnotationSchema, typicalServingSchema, type PolicyMark,
} from "@/lib/coach/ui-blocks";
import type { SanityAnnotation, TypicalServing } from "@/lib/log/sanity-types";
import { deriveMealTitle, sanitizeMealTitle } from "@/lib/coach/meal-title";

export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const foodName = z.string().min(1).max(120);
/** The largest amount one coach item may carry; the apply paths refuse anything outside (0, this]. */
export const MAX_ITEM_GRAMS = 2000;
export const grams = z.number().positive().max(MAX_ITEM_GRAMS);
export const actionItem = z.object({ name: foodName, grams });
export const localDate = () => z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD");
export const clockTime = () => z.string().regex(CLOCK_TIME, "must be HH:MM");

/** `log_meal` may land outside the seven fixed slots: a snack is an extra, not a slot (T6 §3). */
export const LOG_SLOT_IDS = [...SLOT_IDS, "snack"] as const;
export type LogSlot = (typeof LOG_SLOT_IDS)[number];
export type PlanSlot = (typeof SLOT_IDS)[number];

export const mealTitle = z.preprocess(
  (value) => typeof value === "string" ? sanitizeMealTitle(value) : value,
  z.string().min(1).max(40),
);

/** Old stored meal rows gain a bounded dish name from their foods, never from a slot label. */
export function withDerivedTitle(action: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(action.items) ? action.items.filter((item): item is { name: string } =>
    typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string") : [];
  return { ...action, title: action.title === undefined ? deriveMealTitle(items) : action.title };
}

/** A positional enum on the lenient wire: a plain string whose allowed values are described. */
export function describedEnum(values: readonly string[]): z.ZodString {
  return z.string()
    .describe(`Allowed values: ${values.map((value) => `"${value}"`).join(", ")}; "" means absent.`);
}

export type GroundedActionItem = {
  name: string;
  grams: number;
  foodRefId: string;
  catalogFoodRevisionId: number | null;
  kcalPer100g: number | null;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
  verdict: "allowed" | "blocked" | "unverified";
  marks?: PolicyMark[];
  sanity?: SanityAnnotation;
  typicalServing?: TypicalServing;
};

export type GroundedNamedFood = Omit<GroundedActionItem, "grams" | "sanity" | "typicalServing">;
export type GroundedRoleAdvice = {
  foodRefId: string;
  suggestedRole: "protein_anchor" | "carb_source" | "fat_source"
    | "produce_or_free" | "mixed_dish";
  proposedRole?: "protein" | "carb" | "fat" | null;
  currentRole?: "protein" | "carb" | "fat" | null;
  reason?: string;
  confidence: number;
  requiresConfirmation: boolean;
};
export type GroundedBase = { actionId: string; flagged: string[] };

export const groundedNamedFoodSchema = z.object({
  name: foodName,
  foodRefId: z.uuid(),
  catalogFoodRevisionId: z.number().int().nullable(),
  kcalPer100g: z.number().nullable(),
  proteinPer100g: z.number().nullable(),
  carbsPer100g: z.number().nullable(),
  fatPer100g: z.number().nullable(),
  verdict: z.enum(["allowed", "blocked", "unverified"]),
  marks: z.array(policyMarkSchema).max(40).optional(),
});
export const groundedActionItemSchema = groundedNamedFoodSchema.extend({
  grams,
  sanity: sanityAnnotationSchema.optional(),
  typicalServing: typicalServingSchema.optional(),
});
export const sameNameRefs = z.array(z.uuid()).max(SAME_NAME_CAP).optional();
/** Defined beside the capture draft schema, which carries it too (task t2c). */
export { roleAdviceSchema } from "@/lib/coach/ui-blocks";
export const groundedBaseSchema = {
  actionId: z.string().min(1).max(64),
  flagged: z.array(foodName).max(8),
};
