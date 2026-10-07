import { z } from "zod";
import type { SlotId } from "@/lib/coach/types";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA_PATH = /^media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png)$/i;
// Kept local so the canonical turn schema can import this schema without a runtime cycle.
const ATTACHMENT_SLOT_IDS = [
  "coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6", "hot-chocolate",
] as const satisfies readonly SlotId[];

export const barcodeAttachmentSchema = z.object({
  kind: z.literal("barcode"),
  v: z.literal(1),
  gtin14: z.string().regex(/^\d{14}$/, "must be a GTIN-14"),
  foodRefId: z.uuid(),
  revisionId: z.string().regex(/^\d+$/, "must be a catalog revision id"),
  localDate: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
  slot: z.enum(ATTACHMENT_SLOT_IDS).optional(),
  scannedAt: z.iso.datetime({ offset: true }),
});

export const captureAttachmentSchema = z.object({
  kind: z.literal("capture"),
  v: z.literal(1),
  method: z.enum(["photo", "label"]),
  mediaPath: z.string().regex(MEDIA_PATH, "must be media/<uid>/<uuid>.<ext>"),
  localDate: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
  slot: z.enum(ATTACHMENT_SLOT_IDS).optional(),
});

export const coachAttachmentSchema = z.discriminatedUnion("kind", [
  barcodeAttachmentSchema,
  captureAttachmentSchema,
]);

export type BarcodeAttachment = z.infer<typeof barcodeAttachmentSchema>;
export type CaptureAttachment = z.infer<typeof captureAttachmentSchema>;
export type CoachAttachment = z.infer<typeof coachAttachmentSchema>;
