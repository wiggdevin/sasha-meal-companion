/**
 * One zod schema per capture purpose (spec §7). Structured output guarantees shape, not truth, so
 * the same schema re-validates the response after the call (architecture §4.2).
 *
 * Shape adapted from fud-ai (MIT) — one shared item shape across every method, an explicit unit per
 * item, and per-item grams that must be present. See NOTICE.md.
 *
 * per100g is written out key by key rather than as a record: an open map converts to
 * `additionalProperties`, which Gemini cannot express and which would let the model invent a
 * nutrient code we have no unit for.
 *
 * Pure data. No I/O.
 */

import { z } from "zod";
import { NUTRIENT_CODES, type NutrientCode } from "@/lib/nutrients/codes";

export type CapturePurpose = "textToItems" | "voiceToItems" | "labelToNutrients" | "photoToItems";

export type CaptureItem = {
  label: string; grams: number; qty: number; unit: string; confidence: number; brand?: string;
};
export type CaptureItems = { items: CaptureItem[]; notes: string[] };
export type LabelNutrients = {
  /** False when no nutrition panel is clearly visible: the rest is filler and must not be used.
   *  Optional in the type only so older fixtures still compile; the schema requires it. */
  labelReadable?: boolean;
  name: string; brand?: string; servingGrams: number;
  per100g: Record<NutrientCode, number | null>; ingredientsText?: string;
};

/**
 * qty's cap depends on its unit. A stated weight is a qty in that unit ("150 g" = qty 150, unit g,
 * which lib/capture/quantity.ts gramsFor reads as 150 g), so mass units share the 5000 g cap on
 * `grams`; counts and volumes keep 100. lib/ai/json-schema.ts strips numeric bounds from the wire
 * schema, so the provider never sees any of these caps: the prompt's UNITS rule steers the model
 * and this refinement checks the reply when it is parsed.
 */
const MAX_GRAMS = 5000;
const QTY_CAP_BY_UNIT: Record<string, number> = { g: MAX_GRAMS, oz: MAX_GRAMS / 28.3495 };
const QTY_CAP_DEFAULT = 100;

export const captureItemSchema: z.ZodType<CaptureItem> = z.object({
  label: z.string().min(1).max(120),
  grams: z.number().min(0).max(MAX_GRAMS),
  qty: z.number().min(0).max(MAX_GRAMS),
  unit: z.string().min(1).max(24),
  confidence: z.number().min(0).max(1),
  brand: z.string().max(120).optional(),
}).superRefine((item, ctx) => {
  const cap = QTY_CAP_BY_UNIT[item.unit.trim().toLowerCase()] ?? QTY_CAP_DEFAULT;
  if (item.qty > cap) {
    ctx.addIssue({ code: "too_big", maximum: cap, origin: "number", inclusive: true,
      path: ["qty"], message: `qty above ${Math.round(cap)} for unit ${item.unit}` });
  }
}) as z.ZodType<CaptureItem>;

function itemsEnvelope(): z.ZodType<CaptureItems> {
  return z.object({
    items: z.array(captureItemSchema).max(20),
    notes: z.array(z.string().max(200)).max(5),
  }) as z.ZodType<CaptureItems>;
}

/** Distinct objects, not aliases: a per-purpose schema can diverge without touching the others. */
export const textItemsSchema = itemsEnvelope();
export const voiceItemsSchema = itemsEnvelope();
export const photoItemsSchema = itemsEnvelope();

const per100gShape = Object.fromEntries(
  NUTRIENT_CODES.map((code) => [code, z.number().min(0).max(100000).nullable()])
) as unknown as Record<NutrientCode, z.ZodType<number | null>>;

export const per100gSchema = z.object(per100gShape);

export const labelNutrientsSchema: z.ZodType<LabelNutrients> = z.object({
  // 2026-10-03: a blank image came back as an invented "Organic Whole Milk". The model must now
  // say whether it saw a panel at all; lib/server/capture.ts refuses a `false` with 422.
  labelReadable: z.boolean(),
  name: z.string().min(1).max(160),
  brand: z.string().max(120).optional(),
  servingGrams: z.number().min(0).max(5000),
  per100g: per100gSchema,
  ingredientsText: z.string().max(4000).optional(),
}) as z.ZodType<LabelNutrients>;

export const CAPTURE_SCHEMAS: Record<CapturePurpose, z.ZodType> = {
  textToItems: textItemsSchema,
  voiceToItems: voiceItemsSchema,
  labelToNutrients: labelNutrientsSchema,
  photoToItems: photoItemsSchema,
};
