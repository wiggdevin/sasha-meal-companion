/**
 * The Plan sheet's idea chips as a typed request (owner direction 2026-10-08: a chip is never a
 * model call). Each chip maps to a fixed shape on `suggestOptions` (lib/coach/suggest.ts), run by
 * `POST /api/plan/ideas` with no coach turn, no intent classification and no Gemini. At most one
 * Jev ranking call runs, inside the suggestion build, and only when 5 or more cards qualify.
 *
 * Free text, a photo, a link and web or restaurant asks stay on the coach path unchanged.
 *
 * Pure: shared by the phone and the server.
 */
import { z } from "zod";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { SuggestInput } from "@/lib/coach/executors";
import { MEAL_SLOT_IDS, type MealSlotId } from "@/lib/coach/types";
import type { QuickPick } from "@/lib/plan/quick-picks";
import type { Provenance } from "@/lib/types";

export const PLAN_CHIPS = ["choose", "protein", "quick15", "light", "on_hand", "surprise"] as const;
export type PlanChip = (typeof PLAN_CHIPS)[number];

/** The chip each quick-pick label sends. */
export const CHIP_OF: Readonly<Record<QuickPick, PlanChip>> = {
  "Choose for me": "choose",
  "High protein": "protein",
  "Ready in 15 min": "quick15",
  "Something light": "light",
  "Use what I have": "on_hand",
  "Surprise me": "surprise",
};

/** "Something light": the plate's calories, carbs and fat at this share. Protein never shrinks. */
export const LIGHT_SCALE = 0.75;
/** "Ready in 15 min". */
export const QUICK_MINUTES = 15;
/** Cards a chip answers with. */
export const CHIP_CARD_COUNT = 3;
export const MAX_EXCLUDE_IDS = 40;
export const MAX_STATED_FOODS = 15;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const planIdeasRequestSchema = z.object({
  chip: z.enum(PLAN_CHIPS),
  slot: z.enum(MEAL_SLOT_IDS),
  date: z.string().regex(LOCAL_DATE),
  /** The phone's IANA zone; the server checks it before use. */
  zone: z.string().min(1).max(64),
  /** Ideas already said no to ("Not this"): their `ideaId`s. A refill never shows them again. */
  excludeIds: z.array(z.string().min(1).max(400)).max(MAX_EXCLUDE_IDS).optional(),
  /** "Use what I have": foods the person named in the sheet (typed, or read from a photo). */
  stated: z.array(z.string().trim().min(1).max(80)).max(MAX_STATED_FOODS).optional(),
}).strict();
export type PlanIdeasRequest = z.infer<typeof planIdeasRequestSchema>;

/** Where an on-hand card's foods came from, in the order a card names them. */
export const ON_HAND_SOURCES = ["stated", "pantry_photo", "pantry", "list", "favored"] as const;
export type OnHandSource = (typeof ON_HAND_SOURCES)[number];

export const ON_HAND_COPY: Readonly<Record<OnHandSource, string>> = {
  stated: "From what you told me",
  pantry_photo: "From your pantry photo",
  pantry: "From your pantry",
  list: "On your shopping list",
  favored: "From your Favorites",
};

/** No food is known to be on hand: the sheet says so and offers a way to add some. */
export const ON_HAND_EMPTY_MESSAGE =
  "I don’t know what you have yet. Type what’s in your kitchen in the box, or add items to your pantry.";
/** On-hand foods are known, but none of them builds a meal that fits this slot. */
export const ON_HAND_NO_FIT_MESSAGE =
  "Nothing you have on hand makes a meal that fits this slot. Here are ideas from your Favorites.";

/** "Ready in 15 min" found no plate inside the minutes (lib/plan/prep-minutes.ts). */
export const NO_QUICK_MESSAGE =
  "None of the meals I can build for this slot is ready in 15 minutes.";

export type PlanIdeasResponse = {
  cards: ComposedMeal[];
  /** One line the sheet shows above (or instead of) the cards. */
  message?: string;
  /** "Use what I have" found nothing on hand: show the add-items offer. */
  offer?: "add_items";
  provenance: Provenance;
  chip: PlanChip;
  /** Server time for the whole build, ms. */
  serverMs: number;
  /** "Ready in 15 min": `engine` when cards were cut by derived prep minutes. */
  minutesSource?: "engine";
};

/** The `suggestOptions` shape one chip asks for. */
export function chipInput(request: Pick<PlanIdeasRequest, "chip" | "slot" | "date" | "excludeIds">):
  SuggestInput & { slot: MealSlotId } {
  const base = {
    kind: "meal" as const, count: CHIP_CARD_COUNT, fitRemaining: true, slot: request.slot,
    date: request.date, plateTitles: true,
    ...(request.excludeIds?.length ? { excludeIds: request.excludeIds } : {}),
  };
  switch (request.chip) {
    case "protein": return { ...base, proteinFirst: true };
    case "quick15": return { ...base, maxMinutes: QUICK_MINUTES };
    case "light": return { ...base, sizeScale: LIGHT_SCALE };
    case "on_hand": return { ...base, onHandOnly: true };
    case "surprise": return { ...base, novelty: true };
    default: return base;
  }
}
