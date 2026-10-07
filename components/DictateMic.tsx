"use client";

/**
 * Tap to dictate inside the capture sheet's "What you ate" box. The owner's rule: saying the meal
 * is the easiest way to log it, so the text capture always carries a mic.
 *
 * No new speech stack: this is the coach composer's own controller (`HoldController`,
 * lib/coach/hold.ts) on the same ports (lib/voice/dictation-io.ts) — on-device recognition
 * first, the recorder plus server transcription as the fallback. What differs from
 * `components/CoachMic.tsx` is only what the button is for: it never sends. Tap starts, words
 * stream into the box, tap again stops, and the user reviews the box and taps "Check it" on the
 * existing text propose path.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { PERMISSION_COPY } from "@/lib/coach/dictation";
import { HoldController, type HoldView } from "@/lib/coach/hold";
import { latestCallbackPorts, type HoldCallbacks } from "@/lib/coach/hold-ports";
import { micAvailable } from "@/lib/coach/speech-api";
import { dictationIo } from "@/lib/voice/dictation-io";

/** The platform has neither a recogniser nor a recorder: the box is a plain text box. */
export const MIC_UNAVAILABLE_COPY = "Voice is not available here. Type it instead.";
/** A denied microphone, said for this box: typing is the way forward, Settings the way back. */
export const MIC_OFF_COPY = "Microphone access is off. Type it instead, or allow it in Settings.";

/**
 * The controller's lines were written for the coach composer, whose button reads "Record". Here
 * the button is the mic, and a denied microphone points at typing first.
 */
export function dictationCopy(notice: string | null): string | null {
  if (notice === null) return null;
  if (notice === PERMISSION_COPY) return MIC_OFF_COPY;
  return notice.replace("Tap Record", "Tap the mic");
}

/** What the line under the box says while the mic owns it; `null` when it does not. */
export function dictationStatus(view: HoldView): string | null {
  if (view.busy) return "Writing it down…";
  if (view.recording) return `Recording, ${view.secondsLeft} s left. Tap the mic to stop.`;
  if (view.listening) return "Listening. Tap the mic when you are done.";
  if (view.settling) return "Finishing…";
  return null;
}

/** Never subscribes: the answer is a fact about this page load, asked once on the client. */
const noSubscription = (): (() => void) => () => {};

/** Whether this page can dictate at all. The server renders no mic; the phone answers after. */
export function useMicAvailable(): boolean {
  return useSyncExternalStore(noSubscription, micAvailable, () => false);
}

export type DictateMicProps = {
  /** What is in the box right now, so a failed dictation can put it back. */
  readBox: () => string;
  /** Put the transcript so far into the box. */
  writeBox: (text: string) => void;
  disabled: boolean;
  /** Every state change: the parent locks the box and the submit while `locked`. */
  onView: (view: HoldView) => void;
};

function MicGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

export default function DictateMic({ readBox, writeBox, disabled, onView }: DictateMicProps) {
  const [view, setView] = useState<HoldView | null>(null);

  // ONE controller for the component's life; the parent's inline callbacks are read at call time
  // (lib/coach/hold-ports.ts). `null` timing: a capture is not a coach turn.
  const [rig] = useState(() => {
    const built = latestCallbackPorts(
      { readBox, writeBox, publish: () => {} } as HoldCallbacks, dictationIo());
    return { update: built.update, hold: new HoldController(built.ports, null) };
  });
  const hold = rig.hold;

  // No dependency array on purpose, as in CoachMic: the controller must always hold this
  // render's callbacks.
  useEffect(() => {
    rig.update({
      readBox, writeBox,
      publish: (next) => { setView(next); onView(next); },
    });
  });

  useEffect(() => {
    // A microphone must not outlive the sheet, the page or the tab.
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

  const mode = view?.busy || view?.settling ? "busy" : view?.listening ? "stop" : "record";
  const label = mode === "busy" ? "Writing down what you said"
    : mode === "stop" ? "Stop dictation" : "Say what you ate";

  return (
    <button
      type="button"
      onClick={() => {
        const current = hold.view();
        if (mode === "stop" && current.listening) hold.release();
        else if (mode === "record" && !current.locked) hold.press();
      }}
      disabled={mode !== "stop" && disabled}
      aria-disabled={mode === "busy" ? true : undefined}
      aria-label={label}
      aria-pressed={mode === "busy" ? undefined : mode === "stop"}
      className={`tap flex shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${
        // The coach composer's own mic: round white at rest, red while it listens.
        mode === "stop" ? "text-charcoal" : "text-on-primary"}${
        mode === "stop" ? " coach-recording-button" : ""}`}
      style={{
        width: 44, height: 44,
        background: mode === "stop" ? "var(--color-alert)" : "var(--grad-ink)",
      }}
    >
      {mode === "busy" ? <span aria-hidden="true">…</span>
        : mode === "stop" ? (view?.recording
          ? <span className="text-caption font-normal tabular-nums">{view.secondsLeft}</span>
          : <StopGlyph />)
          : <MicGlyph />}
    </button>
  );
}
