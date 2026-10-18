"use client";

import { useState } from "react";
import type { ChatMessage } from "@/lib/coach/chat-state";
import { ASSISTANT_NAME } from "@/lib/brand";

/**
 * The line a screen reader hears for the chat: only a reply that lands while the chat is open,
 * never the restored history or an older page (UI audit 2026-10-18: the whole transcript used to
 * be one polite live region, so VoiceOver queued every message on open).
 */
export function useReplyAnnouncement(messages: readonly ChatMessage[]): string {
  const latest = messages.at(-1);
  const latestId = latest?.id ?? null;
  const [spoken, setSpoken] = useState({ latestId, text: "" });
  if (spoken.latestId !== latestId) {
    const fresh = spoken.latestId !== null && latest?.role === "assistant" && !latest.pending;
    setSpoken({ latestId, text: fresh ? `${ASSISTANT_NAME}: ${latest.content}` : spoken.text });
  }
  return spoken.latestId === latestId ? spoken.text : "";
}
