"use client";

/**
 * Ports for `lib/coach/hold.ts` that never change identity — T7, panel round 1 regression.
 *
 * `components/CoachChat.tsx` passes the mic its callbacks as inline arrows, so they are new
 * objects on every parent render. A controller built in a `useMemo` keyed on them was therefore
 * rebuilt — and the old one cancelled — on the very first render the press caused, which happens
 * before the 300 ms start timer fires: no recogniser was ever created and no hold could start.
 *
 * The fix is identity, not logic, and it belongs here rather than in the component so it can be
 * tested: the ports are built ONCE and read the latest callbacks out of a ref at CALL time. The
 * parent may re-render as often as it likes; the controller it is talking to is the same one.
 */

import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import type { MicHandlers, MicRecorder } from "@/lib/capture-mic";
import type { TranscribeOutcome } from "@/lib/coach-transcribe-client";

/** What the button and the composer render from. Pure data: no refs, no DOM. */
export type HoldView = {
  /** The composer is locked — textarea read-only, Send disabled — until this session is finished. */
  locked: boolean;
  /** A session is open and the recogniser is listening. */
  listening: boolean;
  /** The fallback is recording; `secondsLeft` is the countdown. */
  recording: boolean;
  secondsLeft: number;
  /** The mic button itself is unavailable: a clip is being transcribed. */
  busy: boolean;
  /** The last session has not finished: its last words or its clip are still coming. */
  settling: boolean;
  notice: string | null;
};

export type HoldPorts = {
  listen: (handlers: SpeechHandlers) => SpeechSession | null;
  record: (handlers: MicHandlers) => Promise<MicRecorder | null>;
  transcribe: (clip: Blob) => Promise<TranscribeOutcome>;
  readBox: () => string;
  writeBox: (text: string) => void;
  publish: (view: HoldView) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};


/** The callbacks the parent owns. Replaced wholesale on every render; read only when called. */
export type HoldCallbacks = {
  readBox: () => string;
  writeBox: (text: string) => void;
  publish: (view: HoldView) => void;
};

/** The three I/O ports, which are module functions and never change. */
export type HoldIo = Pick<HoldPorts, "listen" | "record" | "transcribe">;

/** One `ports` object, fixed for the controller's life, plus the way to refresh what it reads. */
export type HoldPortRig = {
  ports: HoldPorts;
  /** Called after every parent render with that render's callbacks. */
  update: (callbacks: HoldCallbacks) => void;
};

/**
 * The callbacks live in this function's closure rather than in a field anybody can assign, so the
 * component refreshes them by CALLING `update` — which is what makes the whole rig safe to hold in
 * `useState` under the React compiler, and what makes this testable with no React at all.
 */
export function latestCallbackPorts(
  initial: HoldCallbacks, io: HoldIo, clock: Partial<HoldPorts> = {},
): HoldPortRig {
  let latest = initial;
  return {
    update: (callbacks) => { latest = callbacks; },
    ports: {
      ...io,
      readBox: () => latest.readBox(),
      writeBox: (text) => latest.writeBox(text),
      publish: (view) => latest.publish(view),
      ...clock,
    },
  };
}
