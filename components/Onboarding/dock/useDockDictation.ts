"use client";

/**
 * Voice for the onboarding dock (GOAL item 1: "talk from the first second, voice first, typing
 * always available"). The same speech stack as the capture box's mic (`components/DictateMic.tsx`):
 * one `HoldController` (lib/coach/hold.ts) on the `dictationIo()` ports (lib/voice/dictation-io.ts)
 * — in a browser tab the on-device recogniser first, then the recorder plus `/api/coach/transcribe`;
 * in the installed PWA the recorder only.
 *
 * What it does NOT do is send. Tap starts, the words stream into the dock's box, tap again stops,
 * and the person reviews the box and taps Send. Send is the shell's own `submitTyped`, so a spoken
 * answer meets exactly the typed answer's local safety gate and extract budget — a spoken health
 * detail is never read by a model before that gate, and never auto-sent.
 *
 * A hook rather than `DictateMic` itself: the dock owns its own round glass button (and the
 * design contract forbids DictateMic's inline colour styles inside it); the controller, the ports
 * and the copy are DictateMic's, unchanged.
 */

import { useEffect, useState } from "react";
import { dictationCopy, dictationStatus, MIC_UNAVAILABLE_COPY, useMicAvailable } from "@/components/DictateMic";
import { HoldController, type HoldView } from "@/lib/coach/hold";
import { latestCallbackPorts, type HoldCallbacks } from "@/lib/coach/hold-ports";
import { dictationIo } from "@/lib/voice/dictation-io";

export type DockMicMode = "record" | "stop" | "busy";

/** When the recorder's upload or transcription is refused. */
export const VOICE_RESTING_COPY = "Voice did not work just now. Type it instead.";

/** DictateMic's lines, plus one rule for this screen: the capture upload's refusal lines point at
 *  food search ("Capture is resting, try search"), which onboarding does not have — here the way
 *  forward is the text box. */
export function onboardingDictationCopy(notice: string | null): string | null {
  const line = dictationCopy(notice);
  return line !== null && /\bsearch\b/i.test(line) ? VOICE_RESTING_COPY : line;
}

export type DockDictation = {
  /** This page can dictate at all (a recogniser or a recorder). The server renders no mic. */
  available: boolean;
  mode: DockMicMode;
  /** The box is the mic's until this session is finished: read-only, no Send. */
  locked: boolean;
  /** The recogniser or the recorder is open now (Sprout's listening pose). */
  hearing: boolean;
  /** The recorder's countdown, while the fallback records. */
  secondsLeft: number | null;
  /** The one plain line under the box: what the mic is doing, why it stopped, or that voice is
   *  not available here. `null` at rest. */
  line: string | null;
  toggle: () => void;
};

export function useDockDictation({ readBox, writeBox, active }: {
  readBox: () => string;
  writeBox: (text: string) => void;
  /** The dock shows the composer now; leaving it ends any session at once. */
  active: boolean;
}): DockDictation {
  const available = useMicAvailable();
  const [view, setView] = useState<HoldView | null>(null);

  // ONE controller for the shell's life; the shell's inline callbacks are read at call time
  // (lib/coach/hold-ports.ts). `null` timing: onboarding is not a coach turn.
  const [rig] = useState(() => {
    const built = latestCallbackPorts(
      { readBox, writeBox, publish: () => {} } as HoldCallbacks, dictationIo());
    return { update: built.update, hold: new HoldController(built.ports, null) };
  });
  const hold = rig.hold;

  // No dependency array on purpose, as in DictateMic: the controller always holds this render's
  // callbacks.
  useEffect(() => {
    rig.update({ readBox, writeBox, publish: (next) => { setView(next); } });
  });

  useEffect(() => {
    // A microphone must not outlive the page or the tab.
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

  // Nor the composer: a beat with no text box ends the session (and drops a clip in flight).
  useEffect(() => {
    if (!active) hold.cancel();
  }, [active, hold]);

  const mode: DockMicMode = view?.busy || view?.settling ? "busy" : view?.listening ? "stop" : "record";
  const line = view ? dictationStatus(view) ?? onboardingDictationCopy(view.notice) : null;
  return {
    available,
    mode,
    locked: view?.locked ?? false,
    hearing: view?.listening ?? false,
    secondsLeft: view?.recording ? view.secondsLeft : null,
    line: line ?? (available ? null : MIC_UNAVAILABLE_COPY),
    toggle: () => {
      const current = hold.view();
      if (mode === "stop" && current.listening) hold.release();
      else if (mode === "record" && !current.locked) hold.press();
    },
  };
}
