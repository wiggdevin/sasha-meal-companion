/**
 * OD06 / W091: the coach's draft reply, streamed while the final model step is still writing it.
 *
 * The route hands runTurn a sink (`StageDeps.draft`); the model loop hands each provider call the
 * `onText` this module builds. Every chunk the provider sends is read for the top-level reply text
 * of a `final` step (lib/coach/draft-text.ts), cleaned the same way the saved reply is
 * (`sanitiseReply`), checked by the local draft guard (lib/coach/draft-guard.ts) and sent at most
 * every DRAFT_INTERVAL_MS. The draft is only ever a preview: cards, actions and the checked reply
 * arrive in the turn itself, which replaces it.
 *
 * An empty string clears a draft already shown: a new model step (a retry, a correction round) or
 * a held draft. Once held, the turn sends no more drafts. A raw `""` from the provider opens a new
 * attempt and clears too. A draft shows whole words only: a word still being written waits for
 * the space or punctuation after it, while the guard reads the text as written, so a fragment of
 * a blocked word never reaches the screen.
 */

import { draftNamesBlocked, draftsHeldFor } from "@/lib/coach/draft-guard";
import { draftTextOf } from "@/lib/coach/draft-text";
import type { EvidenceByName } from "@/lib/coach/policy";
import { sanitiseReply } from "@/lib/coach/turn";
import type { ConstraintProfile } from "@/lib/policy/constraints";

/** Where draft text goes: the streaming route writes each value as one event. */
export type DraftSink = (text: string) => void;

/** At most one draft event per interval; the last text of a burst is never lost. */
export const DRAFT_INTERVAL_MS = 80;

export type DraftStream = {
  /** The provider's raw output for the current attempt so far. */
  onText: (raw: string) => void;
  /** A new model step starts: whatever it writes replaces the draft shown. */
  reset: () => void;
  /** The step answered: its last text goes out now, not after the interval. */
  flush: () => void;
  /** No more drafts this turn; a pending one is dropped, the turn itself follows. */
  close: () => void;
};

const SILENT: DraftStream = { onText: () => {}, reset: () => {}, flush: () => {}, close: () => {} };

export function draftStream(
  sink: DraftSink | undefined, profile: ConstraintProfile, evidence: () => EvidenceByName,
  clock: { now: () => number; setTimer: (run: () => void, ms: number) => () => void } = {
    now: () => Date.now(),
    setTimer: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
  },
): DraftStream {
  if (!sink || draftsHeldFor(profile)) return SILENT;
  let shown = "";
  let pending: string | null = null;
  let lastSent = -Infinity;
  let cancelTimer: (() => void) | null = null;
  let held = false;
  let closed = false;

  const send = (text: string) => {
    if (text === shown) return;
    shown = text;
    lastSent = clock.now();
    try { sink(text); } catch { /* a closed stream: the turn still finishes and saves */ }
  };
  const flush = () => {
    cancelTimer = null;
    if (pending === null || closed) return;
    const text = pending;
    pending = null;
    send(text);
  };
  const hold = () => {
    held = true;
    pending = null;
    cancelTimer?.();
    cancelTimer = null;
    send("");
  };
  const offer = (text: string) => {
    if (closed || held) return;
    pending = text;
    const wait = lastSent + DRAFT_INTERVAL_MS - clock.now();
    if (wait <= 0) { cancelTimer?.(); flush(); return; }
    cancelTimer ??= clock.setTimer(flush, wait);
  };

  const reset = () => { if (shown !== "" || pending !== null) offer(""); };

  return {
    onText: (raw) => {
      if (raw === "") { reset(); return; }
      const written = draftTextOf(raw);
      if (written === null || closed || held) return;
      if (draftNamesBlocked(written, profile, evidence())) { hold(); return; }
      const whole = written.replace(/[\p{L}\p{N}'’]+$/u, "");
      const clean = whole.trim() === "" ? "" : sanitiseReply(whole);
      if (clean !== (pending ?? shown)) offer(clean);
    },
    reset,
    flush: () => { cancelTimer?.(); flush(); },
    close: () => {
      closed = true;
      pending = null;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
