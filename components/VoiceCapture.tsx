// components/VoiceCapture.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { arc, ticks, tracer } from "@/lib/gauge";
import Button from "@/components/ui/Button";
import {
  MAX_RECORDING_SECONDS, openMicRecorder, unsupportedCopy,
  type MicFailureReason, type MicRecorder,
} from "@/lib/capture-mic";

/** The microphone itself lives in lib/capture-mic.ts (T7 §6): the coach's voice fallback opens
 *  the same one, and a `lib/` module may not import a component to reach it. */
export { classifyMicError, unsupportedCopy } from "@/lib/capture-mic";

const MAX_SECONDS = MAX_RECORDING_SECONDS;

/* Mini-gauge geometry from MacroRings (Main.dc.html): 100 px box, 40 px arc radius, 6 px stroke,
   30 ticks between r 44 and r 49, dashed guide at r 30. The arc is charcoal, not a gauge colour —
   DESIGN.md binds orange, blue, olive and gold to the four macros and nothing else. */
const SIZE = 100;
const ARC_R = 40;
const STROKE = 6;

type Phase = "idle" | "recording" | "ready" | "unsupported" | "permission-denied";
type MicFailure = MicFailureReason;

function CountdownRing({ elapsed }: { elapsed: number }) {
  const centre = SIZE / 2;
  const pct = Math.min(1, elapsed / MAX_SECONDS);
  const { circumference, dashoffset } = arc(ARC_R, pct);
  const dot = tracer(centre, centre, ARC_R, pct);
  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true"
        className="absolute inset-0 overflow-visible">
        {ticks(centre, centre, 44, 49, 30).map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke="rgba(0,0,0,0.12)" strokeWidth={2} strokeLinecap="round" />
        ))}
        <circle cx={centre} cy={centre} r={30} fill="none" stroke="rgba(0,0,0,0.12)"
          strokeWidth={1.5} strokeDasharray="3 6" />
        <circle cx={centre} cy={centre} r={ARC_R} fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth={STROKE} />
        <circle cx={centre} cy={centre} r={ARC_R} fill="none" stroke="var(--color-text-primary)" strokeWidth={STROKE}
          strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashoffset}
          transform={`rotate(-90 ${centre} ${centre})`} />
        <circle cx={dot.x} cy={dot.y} r={4} fill="var(--color-text-primary)" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-heading font-light text-charcoal tabular-nums">
          {Math.max(0, Math.ceil(MAX_SECONDS - elapsed))}
        </span>
      </div>
    </div>
  );
}

/* Ink record-button recipe from Main.dc.html's floating quick-add button (line 156): same
   180deg #5a6847→#3d4633 gradient, 1px rgba(0,0,0,0.2) border and inset/drop shadow pair. */
export function RecordButton({
  onPointerDown, onPointerUp, disabled,
}: {
  onPointerDown: () => void;
  onPointerUp: () => void;
  disabled: boolean;
}) {
  // Enter/Space mirror the pointer hold: keydown starts, keyup stops, same as touch-down/lift
  // (audit #73 — the button previously had no keyboard or switch-control path at all). `repeat`
  // is ignored so the OS's key auto-repeat while held doesn't restart the clip on every tick.
  function onKeyDown(event: { key: string; repeat: boolean; preventDefault: () => void }) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.repeat) return;
    onPointerDown();
  }
  function onKeyUp(event: { key: string }) {
    if (event.key !== "Enter" && event.key !== " ") return;
    onPointerUp();
  }

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      disabled={disabled}
      aria-label="Hold to record"
      className="tap flex items-center justify-center rounded-full border border-charcoal/20 text-on-primary disabled:opacity-40"
      style={{
        width: 88, height: 88, touchAction: "none",
        background: "var(--grad-ink)",
        boxShadow: "inset 0 1px 1px rgba(255,255,255,0.12), 0 6px 12px -4px rgba(0,0,0,0.3)",
      }}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
      </svg>
    </button>
  );
}

function StatusCopy({ phase }: { phase: Phase }) {
  // #6d705f is DESIGN.md text-muted (line 14).
  return (
    <p className="text-tiny font-normal text-muted">
      {phase === "recording" ? "Listening. Let go when you are done." : "Hold the button and say what you ate."}
    </p>
  );
}

function ReadyControls({
  clipUrl, busy, onUse, onRetry,
}: {
  clipUrl: string;
  busy: boolean;
  onUse: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <audio controls src={clipUrl} className="w-full" />
      <Button variant="primary" size="lg" block status={busy ? "pending" : undefined} onClick={onUse}>
        Use this clip
      </Button>
      <Button variant="tertiary" block disabled={busy} onClick={onRetry}>Record again</Button>
    </div>
  );
}

function UnsupportedNotice({ reason }: { reason: MicFailure }) {
  // #4a4c42 is DESIGN.md text-secondary (line 13).
  return (
    <p className="text-caption font-normal text-graphite">
      {unsupportedCopy(reason)}
    </p>
  );
}

type RecorderRefs = {
  recorder: React.MutableRefObject<MicRecorder | null>;
  clip: React.MutableRefObject<Blob | null>;
  held: React.MutableRefObject<boolean>;
};

type RecorderCallbacks = {
  setPhase: (phase: Phase) => void;
  setElapsed: (seconds: number) => void;
  setClipUrl: (updater: (old: string | null) => string | null) => void;
};

/**
 * Opens the mic and starts recording, unless the finger has already lifted by the time
 * `getUserMedia` resolves — the normal first-time flow, since accepting the native permission
 * prompt itself lifts the finger off the button. `refs.held` is read only after that await so a
 * release during the prompt cancels the clip immediately instead of recording unattended.
 */
async function beginRecording(refs: RecorderRefs, cb: RecorderCallbacks) {
  cb.setElapsed(0);
  const recorder = await openMicRecorder({
    onClip: (blob) => {
      refs.clip.current = blob;
      cb.setClipUrl((old) => { if (old !== null) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      cb.setPhase("ready");
    },
    onFailure: (reason) => cb.setPhase(reason),
    onElapsed: cb.setElapsed,
  });
  if (recorder === null) return;
  if (!refs.held.current) { recorder.cancel(); return; }
  refs.recorder.current = recorder;
  refs.clip.current = null;
  cb.setPhase("recording");
}

/** All the recording state and the two pointer handlers a phase needs to be driven, kept as one hook so the component body is layout only. */
function useVoiceRecorder(busy: boolean) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const recorder = useRef<MicRecorder | null>(null);
  const clip = useRef<Blob | null>(null);
  const held = useRef(false);

  const stop = useCallback(() => {
    recorder.current?.stop();
    recorder.current = null;
  }, []);

  useEffect(() => () => {
    recorder.current?.cancel();
    recorder.current = null;
    if (clipUrl !== null) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  function handlePointerDown() {
    if (busy || phase === "recording") return;
    held.current = true;
    void beginRecording({ recorder, clip, held }, { setPhase, setElapsed, setClipUrl });
  }

  function handlePointerUp() {
    held.current = false;
    stop();
  }

  function reset() {
    setPhase("idle");
    setElapsed(0);
  }

  return { phase, elapsed, clipUrl, clip, handlePointerDown, handlePointerUp, reset };
}

/**
 * Press and hold to record — spec §6. Thirty seconds is a hard stop, not a hint: the server
 * refuses a longer clip (415) and the countdown is the only warning the user gets. Release, a pointer
 * cancel and the timer all land on the same `stop`, so a finger sliding off the button ends the
 * clip rather than leaving the microphone open.
 */
export default function VoiceCapture({ onReady, busy = false }: {
  onReady: (clip: Blob) => void;
  busy?: boolean;
}) {
  const { phase, elapsed, clipUrl, clip, handlePointerDown, handlePointerUp, reset } = useVoiceRecorder(busy);

  if (phase === "unsupported" || phase === "permission-denied") return <UnsupportedNotice reason={phase} />;

  return (
    <div className="flex flex-col items-center gap-4">
      {phase === "recording" && <CountdownRing elapsed={elapsed} />}

      {phase !== "ready" && (
        <RecordButton onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} disabled={busy} />
      )}

      <StatusCopy phase={phase} />

      {phase === "ready" && clipUrl !== null && (
        <ReadyControls
          clipUrl={clipUrl}
          busy={busy}
          onUse={() => { if (clip.current !== null) onReady(clip.current); }}
          onRetry={reset}
        />
      )}
    </div>
  );
}
