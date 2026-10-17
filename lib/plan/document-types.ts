/**
 * The Plan panel's "+" (upload a meal plan or document): the request the phone sends to
 * POST /api/plan/document and the result it gets back. Both ends parse with these schemas: the
 * server never trusts the phone, and the phone never trusts the response shape. Pure, no I/O.
 *
 * A menu and a recipe come back as an ordinary InspireResult, so the panel reuses its menu picks
 * (components/plan/PhotoResult.tsx) and its recipe ask (planSource). A meal plan comes back as days
 * and meals, plus the one meal matched to this slot with its foods already grounded and screened.
 */
import { z } from "zod";
import { groundedActionItemSchema, type GroundedActionItem } from "@/lib/coach/actions/fields";
import { SLOT_IDS } from "@/lib/coach/types";
import { MAX_DOCUMENT_TEXT, MAX_PDF_BYTES } from "@/lib/plan/document-files";
import { INSPIRE_KINDS, type InspireResult } from "@/lib/plan/inspire-types";
import { provenanceSchema } from "@/lib/provenance";
import type { Macros, Provenance } from "@/lib/types";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MEDIA_PATH = /^media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The base64 length of the largest PDF the phone may send. */
export const MAX_PDF_BASE64 = Math.ceil(MAX_PDF_BYTES / 3) * 4;
/** The request body cap: the largest PDF plus room for the other fields, under Vercel's 4.5 MB. */
export const MAX_DOCUMENT_BODY = MAX_PDF_BASE64 + 4 * 1024;

const slotFields = {
  localDate: z.string().regex(LOCAL_DATE),
  /** The slot the panel is open on: its meal is the one matched and grounded. */
  slot: z.enum(SLOT_IDS),
  slotTime: z.string().regex(CLOCK),
  /** The slot's kcal, so a menu's picks are sized to it. A number only, never the rules. */
  targetKcal: z.number().int().min(100).max(3000).optional(),
};

export const documentRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), mediaPath: z.string().regex(MEDIA_PATH), ...slotFields }),
  z.object({ kind: z.literal("pdf"), data: z.string().min(8).max(MAX_PDF_BASE64).regex(BASE64), ...slotFields }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(MAX_DOCUMENT_TEXT), ...slotFields }),
]);
export type DocumentRequest = z.infer<typeof documentRequestSchema>;

/** `amountUnreadable`: an amount was written but cannot be read; the food is left out, never one portion. */
export type DocumentFood = { name: string; amount: string | null; amountUnreadable?: true };
export type DocumentMeal = { name: string; time: string | null; foods: DocumentFood[] };
export type DocumentDay = { label: string; meals: DocumentMeal[] };

/** A food the matched meal named that will not be placed, and why. Never guessed into the slot. */
export type LeftOutFood = { name: string; amount: string | null; reason: string };

export type DocumentMatch = {
  day: number; meal: number;
  /** The matched meal's name, screened, used as the slot's meal title. */
  title: string;
  /** Grounded through the food search and allowed by the account's rules; what "Use" places. */
  items: GroundedActionItem[];
  left: LeftOutFood[];
  totals: Macros;
};

export type DocumentPlanResult = {
  kind: "meal_plan"; title: string | null; days: DocumentDay[]; match: DocumentMatch | null;
};

/** What a document read gives the panel: a meal plan, nothing usable, or a menu or recipe read. */
export type DocumentResult = (DocumentPlanResult | { kind: "other" } | InspireResult)
  & { provenance?: Provenance };

/** The longest menu "check" line the phone accepts (lib/server/plan-menu.ts askAbout). */
export const MAX_MENU_CHECK = 160;

/**
 * The caps below are the phone's and the narrowest on the path. The model's schemas
 * (lib/ai/document.ts, lib/ai/inspire.ts) are looser on purpose, so one long field does not fail
 * the whole read; the screens (dishTitle 60, foodName 40, cleanTip 80, cleanAmount 24) cut every
 * field to these caps, and the route parses its own response with this schema before sending it.
 */
const text = (max: number) => z.string().min(1).max(max);
const food = z.object({ name: text(40), amount: z.string().max(40).nullable() });
const macros = { kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number() };

export const documentResultSchema = z.union([
  z.object({
    kind: z.literal("meal_plan"), title: z.string().max(60).nullable(),
    days: z.array(z.object({ label: text(60), meals: z.array(z.object({
      name: text(60), time: z.string().regex(CLOCK).nullable(), foods: z.array(food).max(15),
    })).max(10) })).max(8),
    match: z.object({
      day: z.number().int().min(0), meal: z.number().int().min(0), title: text(60),
      items: z.array(groundedActionItemSchema).max(8),
      left: z.array(food.extend({ reason: text(120) })).max(15),
      totals: z.object(macros),
    }).nullable(),
    provenance: provenanceSchema.optional(),
  }),
  z.object({ kind: z.literal("other"), provenance: provenanceSchema.optional() }),
  z.object({
    kind: z.enum(INSPIRE_KINDS), title: z.string().max(60).nullable(),
    ingredients: z.array(z.string().max(40)).max(15),
    menu: z.array(z.object({ name: text(60), ...macros, tip: z.string().max(80).nullable(),
      check: z.string().max(MAX_MENU_CHECK).nullable() })).max(3).optional(),
    provenance: provenanceSchema.optional(),
  }),
]);
