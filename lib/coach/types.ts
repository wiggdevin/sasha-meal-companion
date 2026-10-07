/**
 * Phase 7 coach wire types — docs/specs/phase-7-coach.md "API changes", verbatim.
 *
 * Pure. No I/O, no Supabase import. The slot ids match lib/capture/types.ts SLOT_IDS,
 * duplicated for the same reason that file gives: lib/log/contract.ts does not export
 * them and is a shared file nobody edits on a lane branch.
 */

import { z } from "zod";
import type { CoachAction } from "@/lib/coach/actions";
import { coachAttachmentSchema, type CoachAttachment } from "@/lib/coach/attachments";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { Intent } from "@/lib/coach/intent-types";
import type { CoachMessageView } from "@/lib/coach/message-view";
import { planSkippedSchema, planSourceSchema, type PlanSource } from "@/lib/plan/inspire-types";
import type { Provenance } from "@/lib/types";

export const SLOT_IDS = [
  "coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6", "hot-chocolate",
] as const;

export type SlotId = (typeof SLOT_IDS)[number];
/** A Plan-sheet request names a meal explicitly; it must never be classified as a snack. */
export const MEAL_SLOT_IDS = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6"] as const;
export type MealSlotId = (typeof MEAL_SLOT_IDS)[number];

/** Scoped AI input (lib/coach/scope.ts): the dock tabs a page-scoped ask can come from. */
export const COACH_PAGES = ["today", "body", "foods", "settings"] as const;
export type CoachPage = (typeof COACH_PAGES)[number];

const SCOPE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One meal card (`component`), one dock tab (`page`), or the full coach (`global`). */
export const coachScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("component"), slotId: z.enum(SLOT_IDS),
    date: z.string().regex(SCOPE_DATE) }).strict(),
  z.object({ kind: z.literal("page"), page: z.enum(COACH_PAGES),
    date: z.string().regex(SCOPE_DATE).optional() }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
]);
export type CoachScope = z.infer<typeof coachScopeSchema>;

export const COACH_SURFACES = ["plan", "recipes"] as const;
export type CoachSurface = (typeof COACH_SURFACES)[number];

/**
 * The stored thread kind for a turn. coach_conversations.kind allows chat, plan and weekly_review
 * only, so a recipe-widget thread is a private `plan` thread: hidden from the Coach list, outside
 * the chat-capacity count, and no migration.
 */
export function threadKindFor(
  surface: CoachSurface | undefined, scope?: CoachScope,
): "plan" | "chat" {
  // A meal card's turns are private to the card, like the Plan sheet's; page and global turns run
  // in the account's chat thread (lib/coach/scope.ts).
  return surface || scope?.kind === "component" ? "plan" : "chat";
}

/**
 * `threadId: null` creates a thread from the first message. `messageId` is the idempotency key.
 *
 * `now` and `tz` are THEIR clock (T6 §2): every date the coach reasons about, and every `at` it
 * emits, is in their timezone. They are optional on the wire only so a client that has not been
 * reloaded yet still gets an answer — the server falls back to DEFAULT_TZ and its own clock.
 */
export type CoachTurnRequest = {
  threadId: string | null; messageId: string; text: string;
  now?: string; tz?: string;
  /** Read-only suggestion intent from the open Plan sheet, scoped to its viewed meal. */
  planningSlot?: MealSlotId;
  /**
   * Plan sheet only: the meal slot every later ask (pick, wish, photo, refill) is for. Unlike
   * `planningSlot` it keeps the coach's normal intent path; it only pins the slot the cards fit.
   */
  planSlot?: MealSlotId;
  /**
   * Plan sheets use private plan threads; ordinary Coach turns omit this. `recipes` is the Foods
   * page recipe widget: a private thread too (stored as a `plan` thread, see threadKindFor), with
   * its own guidance block (lib/coach/recipe-surface.ts) and no action fast path.
   */
  surface?: CoachSurface;
  /**
   * Scoped AI input (lib/coach/scope.ts): which meal card, dock tab or the full coach the ask came
   * from. It narrows the allowed actions and the viewed date; absent means global. Never together
   * with `surface`, which is the older narrowing for the Plan sheet and the recipe widget.
   */
  scope?: CoachScope;
  /**
   * Plan sheet only: the foods and dish a photo or recipe link named. Untrusted page or model text,
   * so it never rides in `text`: the server re-screens it and hands it to the model as a fenced data
   * block (lib/server/coach-turn/model-context.ts).
   */
  planSource?: PlanSource;
  /** Plan sheet only: card names the person said no to. Model-written text, so also fenced data. */
  planSkipped?: string[];
  /** Explicitly selected, same-account chat to search for saved evidence. */
  historySourceThreadId?: string;
  /** Attachment-only turns may leave `text` empty; ordinary turns may not. */
  attachment?: CoachAttachment;
  /**
   * Entries the phone has but the server may not: an entry the user logged seconds ago is in their local
   * store and the outbox before it is in `log_entries`. Without them "I ate eggs at 9" → "move it
   * to 1:30" could not find the entry it had just made (T6 §3, Grok pass 1).
   */
  recentEntries?: { entryId: string; what: string }[];
};

export type CoachSuggestion = {
  foodRefId: string | null;          // null when we could not ground the named food
  name: string;
  grams: number | null;
  reason: string | null;             // set when blocked
  verdict: "allowed" | "blocked" | "unverified";
};

/** Never persisted as a log entry: the only path to one is the Phase 4 confirm sheet. */
export type CoachDraft = {
  draftId: string;
  slot: string;
  items: {
    foodRefId: string; name: string; grams: number; catalogFoodRevisionId: number | null;
    /** checkDraft's real per-item verdict (lib/server/coach.ts). Absent means not yet checked. */
    verdict?: "allowed" | "blocked" | "unverified";
  }[];
};

export type CoachTurnResponse = {
  threadId: string;
  suggestions: CoachSuggestion[];
  actions: CoachAction[];
  messages: (Omit<CoachMessageView, "createdAt"> & { createdAt?: string })[];
  draft: CoachDraft | null;
  /** The cards built by `compose_meal` or `suggest_options`; always an array on new replies. */
  composed?: ComposedMeal[];
  /** Present only when the conservative mechanical intent path answered without Gemini. */
  fastPath?: true;
  intent?: Intent;
  deflected: boolean;
  toolsUsed: string[];
  /**
   * `modelId: ""` means no coach-response model was called — deflection, the intent fast path,
   * or an attachment turn. Capture attachment model usage is recorded by `proposeDraft` in
   * `ai_calls`, rather than duplicated on the coach response.
   */
  model: {
    // Owner request 2026-10-02: "openrouter" when the answering modelId is routed there
    // (lib/ai/models.ts isOpenRouterModelId) — COACH_PROVIDER=openrouter or the capacity
    // fallback. Every non-model outcome (deflection, fast path, attachment) keeps "gemini" as
    // the harmless sentinel it always was, alongside its empty modelId.
    provider: "gemini" | "openrouter"; modelId: string;
    /** T6 §5: set when the turn left the pinned model, and why. */
    fellBackBecause?: "capacity" | "failed" };
  /**
   * The server's own ms for this turn (T0 §1): time inside the model calls, and time spent
   * grounding the actions. Attachment turns also report their attachment and reply persistence
   * durations; an attachment replay reports zero attach time and its replay-read duration.
   */
  timings?: {
    intent?: number; model: number; ground: number; attach?: number; "reply-done"?: number;
  };
  /** The request's scope, echoed so the reply can show where it was asked (lib/coach/scope.ts). */
  scope?: CoachScope;
  /**
   * Who produced this turn's reply, actions, draft and cards (lib/types.ts `Provenance`): a model
   * turn, the Jev fast path, or the app (deflection, a structured Plan sheet request, a barcode
   * draft). The same value as the assistant message's own `provenance`; absent when unknown.
   */
  provenance?: Provenance;
};

export const coachTurnRequestSchema: z.ZodType<CoachTurnRequest> = z.object({
  threadId: z.uuid().nullable(),
  messageId: z.uuid(),
  text: z.string().max(2000),
  now: z.iso.datetime({ offset: true }).optional(),
  tz: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/,
    "must be an IANA timezone").optional(),
  planningSlot: z.enum(MEAL_SLOT_IDS).optional(),
  planSlot: z.enum(MEAL_SLOT_IDS).optional(),
  surface: z.enum(COACH_SURFACES).optional(),
  planSource: planSourceSchema.optional(),
  planSkipped: planSkippedSchema.optional(),
  historySourceThreadId: z.uuid().optional(),
  recentEntries: z.array(z.object({
    entryId: z.uuid(), what: z.string().min(1).max(120),
  })).max(20).optional(),
  attachment: coachAttachmentSchema.optional(),
  scope: coachScopeSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.scope && (value.surface || value.planningSlot || value.planSlot)) {
    ctx.addIssue({ code: "custom", path: ["scope"],
      message: "a scope is not available in the Plan sheet or the recipe widget" });
  }
  // A meal card's turns stay about that meal: no saved-chat lookup, no photo or document there
  // (those keep their Plan sheet routes). Page and global scopes run in the account's chat thread.
  if (value.scope?.kind === "component" && (value.historySourceThreadId || value.attachment)) {
    ctx.addIssue({ code: "custom", path: ["scope"],
      message: "history lookup and attachments are not available on a meal card" });
  }
  if (value.text.length === 0 && value.attachment === undefined) {
    ctx.addIssue({ code: "custom", path: ["text"], message: "must not be empty" });
  }
  if (value.historySourceThreadId && (value.surface || value.planningSlot
    || value.attachment)) {
    ctx.addIssue({ code: "custom", path: ["historySourceThreadId"],
      message: "history lookup is only available in Coach chat" });
  }
  if (value.planSlot && value.surface !== "plan") {
    ctx.addIssue({ code: "custom", path: ["planSlot"],
      message: "a plan slot is only available in the Plan sheet" });
  }
  // A photo the recipe widget read carries its foods the same fenced way as the Plan sheet's.
  if ((value.planSource || value.planSkipped) && !value.surface) {
    ctx.addIssue({ code: "custom", path: [value.planSource ? "planSource" : "planSkipped"],
      message: "a plan source is only available in the Plan sheet or the recipe widget" });
  }
  if (value.surface && value.attachment) {
    ctx.addIssue({ code: "custom", path: ["surface"],
      message: "attachments are only available in Coach chat" });
  }
});

export type ConstraintsPut = {
  baseRev: number;
  conditions?: string[];
  avoidAllergens?: string[];
  avoidFoodRefIds?: string[];
  bannedCategories?: string[];
  notes?: string | null;
  customRules?: { id: string; kind: "ingredient" | "cuisine" | "guidance"; text: string }[];
};

export const constraintsPutSchema: z.ZodType<ConstraintsPut> = z.object({
  baseRev: z.number().int().min(0),
  conditions: z.array(z.string().min(1).max(64)).max(20).optional(),
  avoidAllergens: z.array(z.string().min(1).max(40)).max(40).optional(),
  avoidFoodRefIds: z.array(z.uuid()).max(200).optional(),
  bannedCategories: z.array(z.string().min(1).max(40)).max(40).optional(),
  notes: z.string().max(4000).nullable().optional(),
  customRules: z.array(z.object({
    id: z.uuid(), kind: z.enum(["ingredient", "cuisine", "guidance"]),
    text: z.string().trim().min(2).max(80).refine((text) => [...text].length >= 2
      && !/[\u0000-\u001f\u007f]/u.test(text), "Enter a literal name without control characters."),
  }).strict()).max(30).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    "Each rule needs a unique ID.").optional(),
});
