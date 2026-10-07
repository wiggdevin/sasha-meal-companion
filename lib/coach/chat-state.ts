"use client";

/**
 * The coach screen's turn loop as a PURE reducer, beside the component so it can be tested
 * without a React renderer (@testing-library/react is not installed). Split out of
 * components/CoachChat.tsx by T6 §6, and unchanged apart from §4's composed-meal card.
 */

import { UNDO_TIMEOUT_REASON, type UndoToken } from "@/lib/coach/apply-client";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { CachedAction } from "@/lib/coach-client";
import type { CoachDraft, CoachSuggestion, CoachTurnResponse } from "@/lib/coach/types";
import { ASSISTANT_NAME } from "@/lib/brand";
import { localIsoDate } from "@/lib/settings/date";
import type { Provenance } from "@/lib/types";

export const COMPOSER_OFFLINE_COPY = `${ASSISTANT_NAME} needs a connection`;

/** A cross-chat question needs an explicit source instead of a guessed conversation. */
export function asksAboutAnotherConversation(text: string): boolean {
  return /\b(?:other|another|different|previous|earlier|past|last)\s+(?:one\s+)?(?:chat|conversation|thread)\b/i.test(text);
}

/** Their local date and their clock, for the actions the composed card's buttons emit (T6 §4). */
export function localDate(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA",
      { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch { return localIsoDate(at); }
}

export function clockNow(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB",
      { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  } catch { return at.toISOString().slice(11, 16); }
}

export type ChatMessage = { id: string; role: "user" | "assistant"; content: string;
  seq: number; pending?: boolean;
  /** An assistant message's provenance (lib/types.ts `Provenance`); absent on a legacy row. */
  provenance?: Provenance };

export type ChatAction = CachedAction;

export type ChatState = {
  threadId: string | null; messages: ChatMessage[]; suggestions: CoachSuggestion[];
  draft: CoachDraft | null; typing: boolean; error: string | null; retryable: boolean;
  pendingText: string; composerDisabled: boolean; actions: ChatAction[];
  /**
   * The messageId of the turn a retryable error is for. Retry sends it again, so a turn the server
   * saved after the phone gave up is replayed, not answered twice (Sol review, 2026-09-23).
   */
  pendingMessageId: string | null;
  /** T6 §4: the meal `compose_meal` built this turn, if any. */
  composed: SourcedMeal[];
};

/**
 * A card as the turn delivered it, with where it lives in the saved assistant message (its
 * position in `tool_calls.composed`). Cards leave `composed` as they are tapped, so the position in
 * this list is not that index; the stamp is (review t4r10 #2).
 */
export type SourcedMeal = ComposedMeal & { sourceMessageId?: string | null; sourceIndex?: number };

type TurnResponse = Omit<CoachTurnResponse, "composed"> & {
  /** One card is the legacy `compose_meal` wire shape; suggestions carry a list. */
  composed?: ComposedMeal | ComposedMeal[] | null;
};

export type ChatEvent =
  | { type: "reset" }
  | { type: "send"; messageId: string; text: string }
  | { type: "attachment_retry" }
  | { type: "attachment_error"; status: number; code: string; message: string;
      retryAfterSeconds?: number | null; messageId: string }
  | { type: "turn"; response: TurnResponse }
  | { type: "error"; status: number; code: string; message: string; retryAfterSeconds?: number | null;
      messageId?: string }
  | { type: "connection"; online: boolean }
  | { type: "restore"; messages: ChatMessage[]; actions?: ChatAction[] }
  | { type: "action_applied"; actionId: string; token: UndoToken; nutritionUnchecked?: true; notices?: string[] }
  | { type: "action_failed"; actionId: string; reason: string }
  | { type: "action_undo_started"; actionId: string }
  | { type: "action_undo_waiting"; actionId: string }
  | { type: "action_undone"; actionId: string; already?: true }
  | { type: "action_retry"; actionId: string }
  /**
   * A coach action the user tapped in the UI: a composed card (`cardIndex` names which one, and it
   * leaves the screen) or a transcript block such as `food_ideas` (no `cardIndex`; the block hides
   * its own card). Every UI-originated action enters the ledger here, so it gets the same
   * pending/applied/failed card, Undo and Retry as any other, and one actionId is queued once.
   */
  | { type: "compose_action"; action: CoachAction; messageId: string | null; cardIndex?: number };

export function initialChatState(threadId: string | null): ChatState {
  return {
    threadId, messages: [], suggestions: [], draft: null, typing: false, error: null,
    retryable: false, pendingText: "", composerDisabled: false, actions: [], composed: [],
    pendingMessageId: null,
  };
}

function waitCopy(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60
    ? `You have used today's turns with ${ASSISTANT_NAME}. Try again in ${Math.ceil(minutes / 60)} hours.`
    : `That is enough turns with ${ASSISTANT_NAME} for now. Try again in ${minutes} minutes.`;
}

export function nextChatState(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "reset": return { ...initialChatState(null), composerDisabled: state.composerDisabled };
    case "send":
      return {
        ...state, typing: true, error: null, retryable: false, pendingText: event.text,
        pendingMessageId: event.messageId,
        messages: [...state.messages, {
          id: event.messageId, role: "user", content: event.text,
          seq: (state.messages.at(-1)?.seq ?? 0) + 1, pending: true,
        }],
      };
    case "attachment_retry":
      return { ...state, typing: true, error: null, retryable: false };
    case "attachment_error": {
      const retryable = event.status === 0 || event.status === 503;
      return {
        ...state, typing: false,
        retryable,
        error: event.status === 429 && event.retryAfterSeconds
          ? waitCopy(event.retryAfterSeconds)
          : event.message,
        messages: retryable
          ? state.messages
          : state.messages.filter((message) => message.id !== event.messageId),
      };
    }
    case "turn": {
      const fromServer = event.response.messages.map((m) => ({ ...m, pending: false }));
      const ids = new Set(fromServer.map((m) => m.id));
      const messageId = fromServer.findLast((message) => message.role === "assistant")?.id ?? null;
      const incoming = new Set(event.response.actions.map((action) => action.actionId));
      const prior = new Map(state.actions.map((entry) => [entry.action.actionId, entry]));
      const actions = [
        ...state.actions.filter((entry) => !incoming.has(entry.action.actionId)),
        ...event.response.actions.map((action): ChatAction => prior.get(action.actionId)
          ?? { action, status: "pending", messageId,
            ...(event.response.fastPath ? { fastPath: true } : {}) }),
      ];
      return {
        ...state, threadId: event.response.threadId, typing: false, pendingText: "",
        pendingMessageId: null,
        error: null, retryable: false,
        messages: [...state.messages.filter((m) => !ids.has(m.id) && !m.pending), ...fromServer],
        suggestions: event.response.suggestions, draft: event.response.draft, actions,
        composed: (event.response.composed == null ? []
          : Array.isArray(event.response.composed) ? event.response.composed : [event.response.composed])
          .map((meal, index): SourcedMeal => ({ ...meal, sourceMessageId: messageId, sourceIndex: index })),
      };
    }
    case "error":
      return {
        ...state, typing: false,
        // A timeout or network loss may follow a saved reply. Retry with the same ID so the
        // server can replay it; a new first-turn ID could create a second chat.
        retryable: event.status === 0 || event.status === 503,
        pendingMessageId: event.status === 0 || event.status === 503
          ? event.messageId ?? null : null,
        error: event.status === 429 && event.retryAfterSeconds
          ? waitCopy(event.retryAfterSeconds)
          : event.message,
        // Drop the optimistic bubble the failed turn was for, so it doesn't linger forever as
        // a ghost "sending" message and a retry doesn't stack a second copy beside it.
        messages: state.messages.filter((m) => m.id !== event.messageId),
      };
    case "connection":
      return {
        ...state, composerDisabled: !event.online,
        error: event.online
          ? (state.error === COMPOSER_OFFLINE_COPY ? null : state.error)
          : COMPOSER_OFFLINE_COPY,
      };
    case "restore":
      return { ...state, messages: event.messages, actions: event.actions?.map((entry): ChatAction => {
        if (entry.status === "pending") {
          return { ...entry, status: "failed", reason: "That action may not have finished. Try again." };
        }
        if (entry.status === "undoing") {
          return { ...entry, status: "failed", reason: "That undo may not have finished. Try again." };
        }
        return entry;
      }) ?? state.actions };
    case "action_applied":
      return { ...state, actions: state.actions.map((entry) => entry.action.actionId === event.actionId
        ? { ...entry, status: "applied", token: event.token, reason: undefined,
            nutritionUnchecked: event.nutritionUnchecked, notices: event.notices } : entry) };
    case "action_failed":
      return { ...state, actions: state.actions.map((entry) => entry.action.actionId === event.actionId
        ? { ...entry, status: "failed", reason: event.reason } : entry) };
    case "action_undo_started":
      return { ...state, actions: state.actions.map((entry) =>
        entry.action.actionId === event.actionId && entry.status === "applied" && entry.token
          ? { ...entry, status: "undoing", reason: undefined } : entry) };
    case "action_undo_waiting":
      return { ...state, actions: state.actions.map((entry) =>
        entry.action.actionId === event.actionId && entry.status === "undoing"
          ? { ...entry, reason: UNDO_TIMEOUT_REASON } : entry) };
    case "action_retry": {
      const entry = state.actions.find((action) => action.action.actionId === event.actionId);
      if (!entry || entry.status !== "failed" || entry.token) return state;
      return { ...state, actions: state.actions.map((action) => action === entry
        ? { ...action, status: "pending", reason: undefined } : action) };
    }
    case "compose_action":
      // The user tapped a button on a composed card or a food_ideas block. Every item on it was
      // grounded on the server; the shell's apply effect picks it up like any other pending action.
      if (state.actions.some((entry) => entry.action.actionId === event.action.actionId)) {
        return state;
      }
    {
      const card = event.cardIndex === undefined ? undefined : state.composed[event.cardIndex];
      const source = card?.sourceMessageId && typeof card.sourceIndex === "number"
        ? { messageId: card.sourceMessageId, cardIndex: card.sourceIndex } : undefined;
      return { ...state,
        composed: event.cardIndex === undefined ? state.composed
          : state.composed.filter((_, index) => index !== event.cardIndex),
        actions: [...state.actions,
        { action: event.action, status: "pending", messageId: event.messageId,
          ...(source ? { source } : {}) }] };
    }
    case "action_undone":
      return { ...state, actions: state.actions.map((entry) => {
        if (entry.action.actionId !== event.actionId) return entry;
        const { token: _token, reason: _reason, ...rest } = entry;
        return { ...rest, status: "undone", already: event.already };
      }) };
    default:
      return state;
  }
}
