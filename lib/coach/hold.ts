"use client";

import {
  EMPTY_COPY, EMPTY_MS, FINALISE_MS, NO_SPEECH_COPY,
  initialDictation, nextDictation, transcriptOf,
  type DictationEvent, type DictationNotice, type DictationState,
} from "@/lib/coach/dictation";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import type { MicRecorder } from "@/lib/capture-mic";
import { MAX_RECORDING_SECONDS } from "@/lib/capture-mic";
import { discardRun, markMs, type TimingPath } from "@/lib/timing";
import type { HoldPorts, HoldView } from "@/lib/coach/hold-ports";

export type { HoldPorts, HoldView } from "@/lib/coach/hold-ports";

/** Where the fallback's clip is. "flushing" and "transcribing" both mean: it is coming, use it. */
type ClipState = "none" | "opening" | "recording" | "flushing" | "transcribing";

/**
 * Tap to record: `press()` starts a session (the on-device recogniser, or the recorder when
 * `listen` answers null), `release()` stops it, and what was heard joins the draft in the box for
 * the user's own Send. The controller never sends.
 */
export class HoldController {
  private state: DictationState = initialDictation();
  private holding = false;
  private session: SpeechSession | null = null;
  private recorder: MicRecorder | null = null;
  private clipState: ClipState = "none";
  private finaliseTimer: unknown = null;
  private noticeTimer: unknown = null;
  private audioStarted = false;
  private heard = false;
  private restarts = 0;
  private wantClip = false;
  private typed = "";
  private releasedAt = 0;
  private elapsed = 0;
  private notice: string | null = null;
  /** Guards late callbacks and awaited work after cancel or a new session. */
  private gen = 0;
  private carried = "";
  /** One per clip in flight; `cancel()` aborts it so the upload and model call stop. */
  private clipAbort: AbortController | null = null;
  /** `timingPath: null` (the capture box) files no `dictation` step and discards no coach run. */
  constructor(private readonly ports: HoldPorts,
    private readonly timingPath: TimingPath | null = "coach-turn") {}

  view(): HoldView {
    return {
      locked: this.holding || this.state.phase === "finalising" || this.clipState !== "none",
      listening: this.holding && this.state.phase === "listening",
      settling: !this.holding && (this.state.phase === "finalising" || this.clipState !== "none"),
      recording: this.clipState === "recording",
      secondsLeft: Math.max(0, Math.ceil(MAX_RECORDING_SECONDS - this.elapsed)),
      busy: this.clipState === "transcribing",
      notice: this.notice,
    };
  }

  press(): void {
    if (this.holding || this.clipState !== "none" || this.state.phase === "finalising") return;
    this.gen += 1;
    this.carried = "";
    this.typed = this.ports.readBox();
    this.holding = true;
    this.heard = false;
    this.audioStarted = false;
    this.restarts = 0;
    this.releasedAt = 0;
    this.apply({ type: "press" });
    this.showNotice(null);
    this.begin();
    this.publish();
  }

  release(): void {
    if (!this.holding) return;
    this.holding = false;
    this.releasedAt = this.now();
    if (this.clipState !== "none") { this.releaseRecording(); return; }

    this.state = { ...this.state, phase: "finalising" };
    this.session?.stop();
    // stop() may deliver the last final synchronously and settle the session already.
    if (this.state.phase !== "finalising") return;
    if (!this.heard && !this.audioStarted) {
      // The microphone never opened. This was the permission sheet lifting their finger.
      this.session?.abort();
      this.session = null;
      this.quiet();
      return;
    }
    this.finaliseTimer = this.setTimer(() => {
      this.finaliseTimer = null;
      this.settleSpeech(this.apply({ type: "finalised" }));
    }, FINALISE_MS);
    this.publish();
  }

  cancel(): void {
    this.typed = this.ports.readBox();
    this.gen += 1;
    this.wantClip = false;
    this.clearTimer(this.finaliseTimer);
    this.finaliseTimer = null;
    this.session?.abort();
    this.session = null;
    this.recorder?.cancel();
    this.recorder = null;
    this.clipAbort?.abort();
    this.clipAbort = null;
    this.clipState = "none";
    this.holding = false;
    if (this.state.phase === "idle") this.publish();
    else this.abandon(null);
  }

  private begin(): void {
    if (!this.holding) return;
    if (this.state.fallback) { void this.startRecording(); return; }
    const gen = this.gen;
    const session = this.ports.listen(this.handlers(gen));
    if (gen !== this.gen) { session?.abort(); return; }
    this.session = session;
    if (this.session === null && this.holding) void this.startRecording();
  }

  private handlers(gen: number): SpeechHandlers {
    let active = true;
    return {
      onSegment: (segment) => {
        if (!active || gen !== this.gen) return;
        if (segment.text.trim()) this.restarts = 0;
        this.heard = true;
        this.audioStarted = true;
        // After Stop the session is finalising, but its late finals only join the draft: the
        // finalise timer or the session's own end settles it, never a single segment.
        const next = this.state.phase === "finalising"
          ? (this.state = { ...nextDictation({ ...this.state, phase: "listening" },
            { type: "segment", ...segment }), phase: "finalising" })
          : this.apply({ type: "segment", ...segment });
        this.ports.writeBox(this.withDraft(transcriptOf(next)));
        this.publish();
      },
      onError: (code) => {
        if (!active || gen !== this.gen) return;
        if (this.holding && code === "no-speech") {
          active = false;
          this.session?.abort();
          this.session = null;
          this.handleSessionEnd(gen);
          return;
        }
        const next = this.apply({ type: "error", code });
        if (next.phase === "listening" || next.phase === "finalising") return;
        this.session?.abort();
        this.session = null;
        this.holding = false;
        if (next.phase === "sent" || next.phase === "empty") { this.settleSpeech(next); return; }
        this.abandon(next.notice);
      },
      onEnd: () => {
        if (!active || gen !== this.gen) return;
        active = false;
        this.handleSessionEnd(gen);
      },
      onAudioStart: () => {
        if (!active || gen !== this.gen) return;
        this.audioStarted = true;
        if (!this.holding && !this.heard) this.quiet();
      },
    };
  }

  private handleSessionEnd(gen: number): void {
    this.session = null;
    if (!this.holding) {
      if (this.state.phase === "finalising") this.settleSpeech(this.apply({ type: "finalised" }));
      return;
    }
    if (this.state.interim.trim()) {
      this.apply({ type: "segment", text: this.state.interim, final: true });
    }
    if (this.restarts < 1) {
      this.restarts += 1;
      const session = this.ports.listen(this.handlers(gen));
      if (gen !== this.gen) { session?.abort(); return; }
      this.session = session;
      if (session !== null || !this.holding) return;
      this.carried = transcriptOf(this.state);
      void this.startRecording();
      return;
    }
    this.holding = false;
    if (!transcriptOf(this.state).trim()) {
      this.abandon({ text: NO_SPEECH_COPY, ms: 0 });
      return;
    }
    this.releasedAt = this.now();
    this.state = { ...this.state, phase: "finalising" };
    this.settleSpeech(this.apply({ type: "finalised" }));
  }

  private async startRecording(): Promise<void> {
    const gen = this.gen;
    this.wantClip = true;
    this.clipState = "opening";
    this.publish();
    const handle = await this.ports.record({
      onClip: (clip) => { if (gen === this.gen) void this.consumeClip(clip); },
      onFailure: (_reason, copy) => {
        if (gen !== this.gen) return;
        this.holding = false;
        this.clipState = "none";
        this.abandon({ text: copy, ms: 0 });
      },
      onElapsed: (seconds) => {
        if (gen !== this.gen) return;
        this.elapsed = seconds;
        this.publish();
      },
    });
    if (gen !== this.gen) { handle?.cancel(); return; }
    if (handle === null) return;
    if (!this.holding) {
      handle.cancel();
      if (this.clipState === "opening") { this.clipState = "none"; this.quiet(); }
      return;
    }
    this.recorder = handle;
    this.clipState = "recording";
    this.publish();
  }

  private releaseRecording(): void {
    this.apply({ type: "release" });
    if (this.clipState === "recording" && this.recorder !== null) {
      this.clipState = "flushing";
      this.recorder.stop();
      this.recorder = null;
      this.publish();
      return;
    }
    if (this.clipState === "opening") {
      this.clipState = "none";
      this.quiet();
      return;
    }
    this.publish();
  }

  private async consumeClip(clip: Blob): Promise<void> {
    const gen = this.gen;
    this.recorder = null;
    this.elapsed = 0;
    if (!this.wantClip) { this.clipState = "none"; if (this.timingPath) discardRun(this.timingPath); this.publish(); return; }
    if (this.releasedAt === 0) this.releasedAt = this.now();
    this.clipState = "transcribing";
    this.publish();
    const abort = new AbortController();
    this.clipAbort = abort;
    const outcome = await this.ports.transcribe(clip, abort.signal);
    if (this.clipAbort === abort) this.clipAbort = null;
    if (gen !== this.gen) return;
    this.clipState = "none";
    this.holding = false;
    if (!outcome.ok) { this.abandon({ text: outcome.message, ms: 0 }); return; }
    const text = outcome.text.trim();
    if (text.length === 0) { this.abandon({ text: EMPTY_COPY, ms: EMPTY_MS }); return; }
    this.closeDictation();
    this.ports.writeBox(this.withDraft(text));
    this.gen += 1;
    this.showNotice(null);
    this.apply({ type: "settled" });
    this.publish();
  }

  private settleSpeech(next: DictationState): void {
    this.clearTimer(this.finaliseTimer);
    this.finaliseTimer = null;
    this.holding = false;
    if (next.phase !== "sent") { this.abandon(next.notice); return; }
    this.closeDictation();
    const text = this.withDraft(next.text);
    this.gen += 1;
    this.apply({ type: "settled" });
    this.ports.writeBox(text);
    this.publish();
  }

  /** The typed draft, kept exactly as typed, then what was heard. */
  private withDraft(text: string): string {
    const spoken = [this.carried.trim(), text.trim()].filter(Boolean).join(" ");
    return this.typed + (this.typed && spoken && !/\s$/.test(this.typed) ? " " : "") + spoken;
  }

  private abandon(notice: DictationNotice | null): void {
    this.typed = this.ports.readBox();
    this.gen += 1;
    this.clipAbort?.abort();
    this.clipAbort = null;
    this.ports.writeBox(this.typed);
    if (this.timingPath) discardRun(this.timingPath);
    this.showNotice(notice);
    this.apply({ type: "settled" });
    this.publish();
  }

  private quiet(): void {
    this.abandon(null);
  }

  private closeDictation(): void {
    if (this.timingPath) markMs(this.timingPath, "dictation", Math.max(0, this.now() - this.releasedAt));
  }

  private apply(event: DictationEvent): DictationState {
    this.state = nextDictation(this.state, event);
    return this.state;
  }

  private showNotice(notice: DictationNotice | null): void {
    this.clearTimer(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = notice?.text ?? null;
    if (notice === null || notice.ms === 0) return;
    this.noticeTimer = this.setTimer(() => {
      this.noticeTimer = null;
      this.notice = null;
      this.apply({ type: "notice_expired" });
      this.publish();
    }, notice.ms);
  }

  private publish(): void {
    this.ports.publish(this.view());
  }

  private now(): number {
    return (this.ports.now ?? Date.now)();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.ports.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    (this.ports.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }
}
