import { coachAttachmentSchema, type CoachAttachment } from "@/lib/coach/attachments";
import { groundedCoachActionSchema, type CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import { composedMealSchema, uiBlockSchema, type UiBlock } from "@/lib/coach/ui-blocks";
import { tasteChipsProposalSchema, type TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import { BY_APP, byJev, byModel, parseProvenance, type Provenance } from "@/lib/provenance";

export type CoachMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  createdAt: string;
  attachments?: CoachAttachment[];
  blocks?: UiBlock[];
  actions?: CoachAction[];
  composed?: ComposedMeal[];
  historySources?: HistoryCitation[];
  /**
   * Phase 18 W5b-2: the taste chips this reply proposes (dislikes and cuisines, each at p >= 0.8).
   * The card confirms the user's picks through POST /api/profile/taste/confirm with
   * `coach: { messageId: id, proposalId: tasteChips.id }`; nothing is written before that.
   */
  tasteChips?: TasteChipsProposal;
  /**
   * Assistant messages only: who produced this reply and the actions beside it (lib/types.ts
   * `Provenance`). Absent when the stored row cannot tell (a legacy row). A block or card that was
   * produced differently from its message carries its own `provenance`.
   */
  provenance?: Provenance;
};

export type HistoryCitation = {
  id: string; threadId: string; seq: number; createdAt: string; title: string;
  matchTerms?: string[];
};

export type CoachMessageViewRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  created_at?: string | null;
  tool_calls?: unknown;
  /** The stored model columns provenance is derived from; selected by every transcript read. */
  model_id?: string | null;
  ai_call_id?: string | null;
  deflected?: boolean | null;
};

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function validArray<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed === null ? [] : [parsed];
  });
}

function composedOf(value: unknown): ComposedMeal[] {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  return candidates.flatMap((candidate) => {
    const parsed = composedMealSchema.safeParse(candidate);
    return parsed.success ? [withCardProvenance(parsed.data as ComposedMeal)] : [];
  });
}

/**
 * Jev's plausibility label, which lib/coach/suggest-rank.ts appends to a card's rank note only when
 * a usable Jev answer ranked that card ("fits 92 %, natural meal"). A bare "fits 92 %" is the
 * deterministic fit order.
 */
const JEV_RANK_NOTE = /^fits \d+ %, (?:natural|acceptable|not a) /;
const FIT_RANK_NOTE = /^fits \d+ %$/;

/**
 * A suggestion card's own provenance: the stamped value (lib/coach/suggest.ts), else read off the
 * rank note it was saved with. A card with neither (a compose_meal card) inherits its message's.
 */
export function cardProvenance(meal: ComposedMeal): Provenance | undefined {
  const stamped = parseProvenance(meal.provenance);
  if (stamped) return stamped;
  if (typeof meal.rankNote !== "string") return undefined;
  if (JEV_RANK_NOTE.test(meal.rankNote)) return byJev("suggest-options");
  if (FIT_RANK_NOTE.test(meal.rankNote)) return BY_APP;
  return undefined;
}

/**
 * The provenance a card shows: its own, else its turn's — but only for a card with no rank note at
 * all (a compose_meal card). A ranked card that cannot tell (an unstamped, unreadable note) claims
 * nothing, so a fit-ordered card is never labelled AI because its turn was.
 */
export function mealProvenance(meal: ComposedMeal, turn: Provenance | undefined): Provenance | undefined {
  const own = cardProvenance(meal);
  if (own) return own;
  return meal.rankNote ? undefined : turn;
}

function withCardProvenance(meal: ComposedMeal): ComposedMeal {
  const { provenance: _stored, ...rest } = meal;
  const provenance = cardProvenance(meal);
  return provenance ? { ...rest, provenance } : rest;
}

/**
 * Who produced an assistant row, from facts the row holds: the provenance the turn stamped into
 * `tool_calls` (lib/server/coach-turn/finish.ts), else the model columns — a `model_id` or an
 * `ai_call_id` means a model wrote it; `deflected`, or the weekly review's empty `model_id`
 * (lib/server/coach.ts, a fallback written from logged days), means the app did — else a legacy
 * fast-path row (Jev chose a non-suggestion action) or a capture draft block. Undefined when the
 * row cannot tell; never a guess.
 */
export function messageProvenance(row: CoachMessageViewRow): Provenance | undefined {
  if (row.role !== "assistant") return undefined;
  const calls = objectOf(row.tool_calls);
  const stored = parseProvenance(calls?.provenance);
  if (stored) return stored;
  if ((typeof row.model_id === "string" && row.model_id !== "")
    || (typeof row.ai_call_id === "string" && row.ai_call_id !== "")) return byModel();
  if (row.deflected === true || row.model_id === "") return BY_APP;
  // Before provenance was stamped, a fast path that was not a suggestion was always a Jev intent:
  // the Plan sheet's structured request (no Jev) only ever runs suggest_options.
  if (calls?.fastPath === true && typeof calls.intent === "string"
    && calls.intent !== "suggest_options") return byJev("coach-intent");
  const draft = Array.isArray(calls?.blocks)
    ? calls.blocks.map((block) => objectOf(block)).find((block) => block?.kind === "log_draft")
    : undefined;
  if (draft?.source === "capture") return byModel();
  if (draft?.source === "barcode") return BY_APP;
  return undefined;
}

/** A block's own provenance when it differs by kind from its message's (read, never trusted). */
function blockProvenance(block: UiBlock, message: Provenance | undefined): UiBlock {
  switch (block.kind) {
    // Only a model's quick_replies tool call makes these (lib/coach/blocks/quick-replies.ts).
    case "quick_replies":
      return { ...block, provenance: message?.ai && message.source === "model" ? message : byModel() };
    // lib/coach/next-action.ts ranks a fixed set of chips in code.
    case "next_action_chip":
      return { ...block, provenance: BY_APP };
    case "log_draft": {
      const stamped = parseProvenance((block.draft as { provenance?: unknown }).provenance);
      return { ...block,
        provenance: stamped ?? (block.source === "barcode" ? BY_APP : byModel()) };
    }
    case "food_ideas":
      return { ...block, ideas: block.ideas.map((idea) => withCardProvenance(idea as ComposedMeal)) };
    default:
      return block;
  }
}

export function toMessageView(row: CoachMessageViewRow): CoachMessageView {
  const calls = objectOf(row.tool_calls);
  const provenance = messageProvenance(row);
  const attachments = validArray(calls?.attachments, (item) => {
    const parsed = coachAttachmentSchema.safeParse(item);
    return parsed.success ? parsed.data : null;
  });
  const blocks = validArray(calls?.blocks, (item) => {
    const parsed = uiBlockSchema.safeParse(item);
    return parsed.success ? blockProvenance(parsed.data, provenance) : null;
  });
  const actions = validArray(calls?.actions, (item) => {
    const parsed = groundedCoachActionSchema.safeParse(item);
    return parsed.success ? parsed.data : null;
  });
  const composed = composedOf(calls?.composed);
  const tasteChipsRead = row.role === "assistant" ? tasteChipsProposalSchema.safeParse(calls?.tasteChips) : null;
  const tasteChips = tasteChipsRead?.success ? tasteChipsRead.data : null;
  const historySources = validArray(calls?.historySources, (item): HistoryCitation | null => {
    const source = objectOf(item);
    if (!source || typeof source.id !== "string" || typeof source.threadId !== "string"
      || typeof source.seq !== "number" || !Number.isSafeInteger(source.seq)
      || typeof source.createdAt !== "string" || typeof source.title !== "string") return null;
    const matchTerms = Array.isArray(source.matchTerms)
      ? source.matchTerms.filter((term): term is string => typeof term === "string"
        && /^[\p{L}\p{N}]{3,40}$/u.test(term)).slice(0, 8) : [];
    return { id: source.id, threadId: source.threadId, seq: source.seq,
      createdAt: source.createdAt, title: source.title,
      ...(matchTerms.length ? { matchTerms } : {}) };
  }).slice(0, 4);

  return {
    id: row.id,
    role: row.role,
    content: row.content,
    seq: row.seq,
    createdAt: row.created_at ?? new Date(0).toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(composed.length > 0 ? { composed } : {}),
    ...(historySources.length > 0 ? { historySources } : {}),
    ...(tasteChips ? { tasteChips } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
