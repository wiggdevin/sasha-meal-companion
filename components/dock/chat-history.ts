"use client";

import { useCallback, useEffect, useRef } from "react";

/** Marks the history entry the chat overlay pushes, so the back gesture can close it. */
export const CHAT_HISTORY_KEY = "smcChatOverlay";
/** If stepping back never reports (no popstate), the overlay closes anyway after this long. */
const BACK_FALLBACK_MS = 400;

let openings = 0;

/** The opening an entry belongs to, or null for any other entry. */
function entryOf(state: unknown): number | null {
  const mark = state && typeof state === "object" ? (state as Record<string, unknown>)[CHAT_HISTORY_KEY] : null;
  return typeof mark === "number" ? mark : null;
}

/**
 * The back gesture closes the chat overlay (U22), as it would a page: each opening pushes one entry
 * on the same URL, marked with its own number (Next's patched pushState keeps its router state on
 * it, so nothing navigates), and a popstate that leaves that entry calls `onPop`, even when it
 * lands on an older opening's entry. The returned `dismiss` is how the UI closes it: it steps back
 * over the entry, so the history never collects one stale entry per opening. A route change while
 * open (a tab, "Open full chat") leaves the entry behind; nothing steps back then.
 */
export function useChatHistory(open: boolean, onPop: () => void): () => void {
  const pushed = useRef<number | null>(null);
  const onPopRef = useRef(onPop);
  useEffect(() => { onPopRef.current = onPop; }, [onPop]);

  useEffect(() => {
    if (!open) { pushed.current = null; return; }
    const opening = ++openings;
    window.history.pushState({ [CHAT_HISTORY_KEY]: opening }, "");
    pushed.current = opening;
    const pop = () => {
      if (pushed.current !== opening || entryOf(window.history.state) === opening) return;
      pushed.current = null;
      onPopRef.current();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [open]);

  return useCallback(() => {
    const opening = pushed.current;
    if (opening !== null && entryOf(window.history.state) === opening) {
      window.history.back();
      setTimeout(() => {
        if (pushed.current !== opening) return;
        pushed.current = null;
        onPopRef.current();
      }, BACK_FALLBACK_MS);
      return;
    }
    pushed.current = null;
    onPopRef.current();
  }, []);
}

/** Whether the entry on top is an overlay's own (the caller may replace it instead of pushing). */
export function onOverlayEntry(): boolean {
  return typeof window !== "undefined" && entryOf(window.history.state) !== null;
}
