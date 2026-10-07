import type { CoachAttachment } from "@/lib/coach/attachments";
import {
  nextChatState, type ChatEvent, type ChatMessage, type ChatState,
} from "@/lib/coach/chat-state";
import type { CoachMessageView } from "@/lib/coach/message-view";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";

export type CoachShellMessage = ChatMessage &
Partial<Pick<CoachMessageView, "attachments" | "blocks" | "createdAt">>;
export type CoachShellState = Omit<ChatState, "messages"> & { messages: CoachShellMessage[] };
type SendEvent = Omit<Extract<ChatEvent, { type: "send" }>, "type"> & {
  type: "send";
  attachment?: CoachAttachment;
};
export type CoachShellEvent = Exclude<ChatEvent, { type: "send" }> | SendEvent | {
  type: "block_status";
  blockId: string;
  status: LogDraftBlockV1["status"];
  entryIds?: string[];
};

function blockStatus(state: CoachShellState, event: Extract<CoachShellEvent, { type: "block_status" }>) {
  return {
    ...state,
    messages: state.messages.map((message) => ({
      ...message,
      blocks: message.blocks?.map((block) => {
        if (block.kind !== "log_draft" || block.id !== event.blockId) return block;
        const { entryIds: _entryIds, ...rest } = block;
        return { ...rest, status: event.status,
          ...(event.entryIds === undefined ? {} : { entryIds: event.entryIds }) };
      }),
    })),
  };
}

/** Extends the pure chat reducer only for attachment rows and transcript block status. */
export function nextCoachShellState(state: CoachShellState, event: CoachShellEvent): CoachShellState {
  if (event.type === "block_status") return blockStatus(state, event);
  if (event.type === "send") {
    const next = nextChatState(state, event) as CoachShellState;
    if (!event.attachment) return next;
    return { ...next, messages: next.messages.map((message) => message.id === event.messageId
      ? { ...message, attachments: [event.attachment!] } : message) };
  }
  if (event.type === "turn") {
    const local = new Map(state.messages.filter((message) => message.attachments?.length)
      .map((message) => [message.id, message]));
    const messages: CoachShellMessage[] = event.response.messages.map((message) => {
      const pending = local.get(message.id);
      return pending?.attachments?.length && !message.attachments?.length
        ? { ...message, attachments: pending.attachments, pending: false }
        : { ...message, pending: false };
    });
    for (const pending of local.values()) {
      if (pending.pending && !messages.some((message) => message.id === pending.id)) {
        messages.push({ ...pending, pending: false });
      }
    }
    messages.sort((a, b) => a.seq - b.seq);
    return nextChatState(state, { ...event,
      response: { ...event.response, messages } }) as CoachShellState;
  }
  return nextChatState(state, event) as CoachShellState;
}
