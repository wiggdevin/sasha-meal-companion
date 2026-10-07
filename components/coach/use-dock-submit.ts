"use client";

import { useEffect } from "react";

export const COACH_DOCK_SUBMIT_EVENT = "coach:dock-submit";

/**
 * A question asked from the dock on another screen. The dock routes to /coach and parks the text
 * here; the coach shell sends it once its thread is ready. Module state, so it survives the
 * client-side navigation but never a reload (the text is never written to the URL or storage).
 */
let pendingDockText: string | null = null;

export function queueCoachDockText(text: string): void {
  const trimmed = text.trim();
  if (trimmed) pendingDockText = trimmed;
}

/**
 * Hands dock text to a mounted chat (/coach, or the dock's chat overlay), or parks it for the chat
 * that is about to mount. The listener marks `detail.received`, so text sent while the overlay is
 * still resuming its thread is queued instead of lost. Answers whether the text was taken.
 */
export function deliverDockText(text: string): boolean {
  const detail: { text: string; accepted: boolean; received?: boolean } = { text, accepted: true };
  window.dispatchEvent(new CustomEvent(COACH_DOCK_SUBMIT_EVENT, { detail }));
  if (detail.received) return detail.accepted;
  queueCoachDockText(text);
  return true;
}

/**
 * DeepSeek audit 2026-10-02, finding 2: `send` reports whether CoachShell actually took the turn —
 * `false` when it bailed early (restoring, typing, disabled, or the "ask about another
 * conversation" intercept) — and that answer is written back onto the event's own `detail` while
 * dispatch is still synchronous, so AssistantField's submitText can hand it straight back to
 * use-composer-input's send() instead of always reporting success.
 */
export function useCoachDockSubmit(send: (text: string) => boolean | void, ready = true): void {
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown; accepted?: boolean; received?: boolean }>).detail;
      if (detail) detail.received = true;
      const text = detail?.text;
      if (typeof text === "string" && text.trim() && send(text.trim()) === false && detail) {
        detail.accepted = false;
      }
    };
    window.addEventListener(COACH_DOCK_SUBMIT_EVENT, receive);
    return () => window.removeEventListener(COACH_DOCK_SUBMIT_EVENT, receive);
  }, [send]);

  useEffect(() => {
    if (!ready || pendingDockText === null) return;
    const text = pendingDockText;
    pendingDockText = null;
    send(text);
  }, [ready, send]);
}
