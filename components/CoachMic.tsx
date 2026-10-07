"use client";

/**
 * Tap to record on the coach composer. The controller owns both listening routes (the on-device
 * recogniser and the recorder fallback); this button only starts and stops a session.
 *
 * A button, and nothing else. The controller reports its state through `view()`.
 *
 * ONE controller, for the life of the component. The parent hands its callbacks down as inline
 * arrows, so they are new on every render; the controller reads them through a ref that is
 * refreshed after each one (`lib/coach/hold-ports.ts`). A controller keyed on those callbacks was
 * rebuilt — and the hold in progress cancelled — by the very re-render the press itself caused.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HoldController, type HoldView } from "@/lib/coach/hold";
import { latestCallbackPorts, type HoldCallbacks } from "@/lib/coach/hold-ports";
import { micAvailable } from "@/lib/coach/speech-api";
import { dictationIo } from "@/lib/voice/dictation-io";
import { SendGlyph } from "@/components/coach/round-button";
import type { ActionFeedbackPhase } from "@/components/ui/ActionFeedback";

export type CoachMicProps = {
  /** What is in the composer right now, so a failed recording can put it back. */
  readBox: () => string;
  /** Put the live transcript — or the fallback's answer — into the composer. */
  writeBox: (text: string) => void;
  /** The composer's disabled state — offline, restoring, or a turn in flight. */
  disabled: boolean;
  /** The typed path's explicit Send action. */
  onSend: (text: string) => void;
  /** A draft outside active editing makes the one main control Send. */
  readyToSend: boolean;
  reviewNeeded: boolean;
  onReviewNeeded: (needed: boolean) => void;
  onRecordPointerDown: () => void;
  onRecordPointerDone: () => void;
  onActionPointerUp: (event: import("react").PointerEvent<HTMLElement>) => boolean;
  onActionStart: () => void;
  onActionClick: (detail: number) => boolean;
  /** True while dictation owns the composer: textarea read-only, Send disabled. */
  onListening: (locked: boolean) => void;
  /** One line under the composer, or null. */
  onNotice: (copy: string | null) => void;
  /** The in-flight turn's own pending/success glow (`useSendFeedback`), while this is the one
   *  control that sends: announced on the button itself, since there is no separate Send button
   *  to carry it (the page composer that had one is gone; the dock is the one ask field now). */
  sendFeedbackState?: ActionFeedbackPhase;
  sendFeedbackClassName?: string;
};

const IDLE: HoldView = {
  locked: false, listening: false, recording: false, secondsLeft: 0, busy: false,
  settling: false, notice: null,
};

/** Never subscribes: the answer is a fact about this page load, asked once on the client. */
const noSubscription = (): (() => void) => () => {};

export default function CoachMic({
  readBox, writeBox, disabled, onSend, readyToSend, reviewNeeded, onReviewNeeded,
  onRecordPointerDown, onRecordPointerDone, onActionPointerUp,
  onActionStart, onActionClick, onListening, onNotice,
  sendFeedbackState, sendFeedbackClassName,
}: CoachMicProps) {
  const [view, setView] = useState<HoldView>(IDLE);
  const wasLocked = useRef(false);
  const manualStop = useRef(false);
  const reviewPending = useRef(false);
  const activationMode = useRef<"busy" | "stop" | "review" | "send" | "record" | null>(null);

  /**
   * §3's last row. The server renders neither API, so it renders no mic; the phone answers for
   * itself after hydration. Whether the mic WORKS is asked again at press time.
   */
  const available = useSyncExternalStore(noSubscription, micAvailable, () => false);

  /**
   * The controller and its ports, built ONCE together. The ports hold the parent's callbacks in a
   * closure and the component refreshes them by calling `update` after every render — so the
   * parent may hand down new inline arrows as often as it likes and the controller never changes.
   */
  const [rig] = useState(() => {
    // The listener rule (on-device first in a tab, the recorder in the installed app) lives in
    // lib/voice/dictation-io.ts, shared with the capture sheet's description box.
    const built = latestCallbackPorts(
      { readBox, writeBox, publish: () => {} } as HoldCallbacks,
      dictationIo(),
    );
    return { update: built.update, hold: new HoldController(built.ports) };
  });
  const hold = rig.hold;

  // No dependency array on purpose: the parent passes inline arrows, so its callbacks are new on
  // every render and the controller must always be holding the current ones. They are read only
  // from an event handler, which runs after this has refreshed them.
  useEffect(() => {
    rig.update({
      readBox, writeBox,
      publish: (next) => {
        if (wasLocked.current && !next.locked) {
          reviewPending.current = !manualStop.current && Boolean(readBox().trim());
          onReviewNeeded(reviewPending.current);
          manualStop.current = false;
        }
        wasLocked.current = next.locked;
        setView(next);
        onListening(next.locked);
        onNotice(next.notice);
      },
    });
  });

  useEffect(() => {
    // A recording that outlives the page is a microphone left on. `pagehide` is the one iOS Safari
    // reliably fires; `visibilitychange` covers a tab switch on everything else. `hold` is stable,
    // so this cleanup runs on unmount and nowhere else.
    const end = (): void => hold.cancel();
    const hidden = (): void => { if (document.visibilityState === "hidden") hold.cancel(); };
    window.addEventListener("pagehide", end);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", end);
      document.removeEventListener("visibilitychange", hidden);
      hold.cancel();
    };
  }, [hold]);

  // DeepSeek audit 2026-10-02, finding 1: this used to read `mode === "send"`, but `send()` in
  // use-composer-input.ts clears the draft the instant it hands the text off — before CoachShell's
  // async turn ever reaches "pending" — so `mode` had already fallen back to "record" by the time
  // there was anything to show. The glow is a fact about the in-flight turn, not about the draft.
  const feedbackActive = !view.listening
    && (sendFeedbackState === "pending" || sendFeedbackState === "success");
  const mode = view.busy || view.settling ? "busy"
    : view.listening ? "stop"
      : feedbackActive ? "send"
        : reviewNeeded ? "review"
          : readyToSend ? "send" : "record";
  if (!available && mode === "record") return null;

  return (
    <button
      type="button"
      data-composer-action
      data-composer-main
      data-feedback-state={feedbackActive ? sendFeedbackState : undefined}
      onPointerDown={() => {
        onActionStart();
        activationMode.current = mode;
        if (mode === "record") onRecordPointerDown();
      }}
      onPointerUp={(event) => {
        if (onActionPointerUp(event)) activationMode.current = null;
      }}
      onPointerLeave={(event) => {
        if (event.buttons !== 0) { activationMode.current = null; onRecordPointerDone(); }
      }}
      onPointerCancel={() => { activationMode.current = null; onRecordPointerDone(); }}
      onBlur={() => { activationMode.current = null; }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          if (event.repeat) event.preventDefault();
          else { onActionStart(); activationMode.current = mode; }
        }
      }}
      onClick={(event) => {
        const startedAs = activationMode.current;
        activationMode.current = null;
        if (onActionClick(event.detail)) return;
        if (startedAs && startedAs !== mode) return;
        const current = hold.view();
        if (mode === "send") {
          if (!current.locked && !reviewPending.current && event.detail <= 1 && !feedbackActive) {
            onSend(readBox());
          }
        } else if (mode === "review") {
          if (current.locked || !reviewPending.current) return;
          reviewPending.current = false;
          onReviewNeeded(false);
        } else if (mode === "record") {
          if (current.locked || reviewPending.current) return;
          manualStop.current = false;
          hold.press();
        } else if (mode === "stop" && current.listening) {
          manualStop.current = true;
          hold.release();
        }
      }}
      disabled={(mode !== "stop" && disabled) || feedbackActive}
      aria-disabled={mode === "busy" ? true : undefined}
      aria-busy={feedbackActive && sendFeedbackState === "pending" ? true : undefined}
      aria-label={mode === "busy" ? view.busy ? "Transcribing voice message" : "Finishing recording"
        : mode === "stop" ? "Stop recording" : mode === "review" ? "Review recording"
          : mode === "send" ? (feedbackActive
            ? sendFeedbackState === "pending" ? "Sending message" : "Message sent" : "Send")
            : "Record message"}
      aria-pressed={mode === "record" || mode === "stop" ? mode === "stop" : undefined}
      className={`tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${mode === "stop" ? "text-charcoal coach-recording-button" : "text-on-primary"}${feedbackActive && sendFeedbackClassName ? ` ${sendFeedbackClassName}` : ""}`}
      style={{
        // At rest the same round white button as the chat box's others; red while it records.
        background: mode === "stop" ? "var(--color-alert)" : "var(--grad-ink)",
      }}
    >
      {mode === "busy" ? <span aria-hidden="true">…</span> : mode === "send" ? <SendGlyph /> : mode === "review" ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      ) : mode === "stop" ? (
        <span className="tabular-nums text-caption font-normal">
          {view.recording ? view.secondsLeft : <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>}
        </span>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </svg>
      )}
    </button>
  );
}
