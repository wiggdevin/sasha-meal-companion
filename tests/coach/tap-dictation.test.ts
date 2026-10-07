import { describe, expect, it, vi } from "vitest";
import { HoldController } from "@/lib/coach/hold";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import type { MicHandlers, MicRecorder } from "@/lib/capture-mic";
import { FINALISE_MS, PERMISSION_COPY } from "@/lib/coach/dictation";

function harness() {
  const box = { value: "" };
  const speech: SpeechHandlers[] = [];
  const mics: MicHandlers[] = [];
  const recorders: { stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }[] = [];
  let useRecorder = false;
  let open: (() => void) | null = null;
  const transcribe = vi.fn(async () => ({ ok: true as const, text: "from clip", ms: 1 }));
  const hold = new HoldController({
    listen: (handlers) => {
      if (useRecorder) return null;
      speech.push(handlers);
      return { stop: vi.fn(), abort: vi.fn() } as SpeechSession;
    },
    record: async (handlers) => {
      mics.push(handlers);
      if (open) await new Promise<void>((resolve) => { open = resolve; });
      const recorder = { stop: vi.fn(), cancel: vi.fn() };
      recorders.push(recorder);
      return { ...recorder, mimeType: "audio/mp4" } as MicRecorder;
    },
    transcribe,
    readBox: () => box.value,
    writeBox: (value) => { box.value = value; },
    publish: vi.fn(),
  });
  return {
    hold, box, speech, mics, recorders, transcribe,
    recorderOnly: () => { useRecorder = true; },
    pendingPermission: () => { open = () => {}; },
    allowPermission: () => { open?.(); open = null; },
  };
}

describe("tap dictation", () => {
  it("starts on one tap and leaves speech plus the typed draft for explicit Send", () => {
    const h = harness();
    h.box.value = "I would like";
    h.hold.press();
    expect(h.speech).toHaveLength(1);
    expect(h.hold.view().listening).toBe(true);
    h.speech[0].onAudioStart?.();
    h.speech[0].onSegment({ text: "a snack", final: true });
    expect(h.box.value).toBe("I would like a snack");
    h.hold.release();
    h.speech[0].onEnd();
    expect(h.hold.view().locked).toBe(false);
    expect(h.box.value).toBe("I would like a snack");
  });

  it("does not send after a late final result", () => {
    const h = harness();
    h.hold.press();
    const handler = h.speech[0];
    handler.onAudioStart?.();
    h.hold.release();
    handler.onSegment({ text: "last words", final: true });
    handler.onEnd();
    expect(h.box.value).toBe("last words");
    expect(h.hold.view().locked).toBe(false);
  });

  it("keeps every final in the recognizer batch after Stop", () => {
    const h = harness();
    h.hold.press();
    const handler = h.speech[0];
    handler.onSegment({ text: "before stop", final: true });
    h.hold.release();
    expect(h.hold.view().settling).toBe(true);
    handler.onSegment({ text: "tail one", final: true });
    handler.onSegment({ text: "tail two", final: true });
    handler.onEnd();
    expect(h.box.value).toBe("before stop tail one tail two");
    expect(h.hold.view().locked).toBe(false);
  });

  it("flushes all final segments on the existing finalise timeout", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.hold.press();
      const handler = h.speech[0];
      handler.onSegment({ text: "first", final: true });
      h.hold.release();
      handler.onSegment({ text: "last", final: true });
      vi.advanceTimersByTime(FINALISE_MS);
      expect(h.box.value).toBe("first last");
      expect(h.hold.view().locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts after repeated speech-separated pauses until Stop", () => {
    const h = harness();
    h.hold.press();
    h.speech[0].onSegment({ text: "first", final: true });
    h.speech[0].onEnd();
    expect(h.hold.view().listening).toBe(true);
    h.speech[1].onSegment({ text: "second", final: true });
    h.speech[1].onEnd();
    expect(h.speech).toHaveLength(3);
    h.speech[2].onSegment({ text: "third", final: true });
    h.hold.release();
    expect(h.box.value).toBe("first second third");
  });

  it("keeps an interim phrase across an ordinary recognizer restart", () => {
    const h = harness();
    h.hold.press();
    h.speech[0].onSegment({ text: "one", final: false });
    h.speech[0].onEnd();
    expect(h.speech).toHaveLength(2);
    h.speech[1].onSegment({ text: "two", final: true });
    h.hold.release();
    h.speech[1].onEnd();
    expect(h.box.value).toBe("one two");
    expect(h.hold.view().locked).toBe(false);
  });

  it("treats mid-recording no-speech as one bounded restart", () => {
    const h = harness();
    h.hold.press();
    h.speech[0].onSegment({ text: "first", final: false });
    h.speech[0].onError("no-speech");
    h.speech[0].onEnd(); // The aborted session may still report its end.
    expect(h.speech).toHaveLength(2);
    expect(h.hold.view().listening).toBe(true);
    h.speech[1].onSegment({ text: "second", final: true });
    h.hold.release();
    expect(h.box.value).toBe("first second");

    const silent = harness();
    silent.hold.press();
    silent.speech[0].onError("no-speech");
    expect(silent.speech).toHaveLength(2);
    silent.speech[1].onError("no-speech");
    expect(silent.speech).toHaveLength(2);
    expect(silent.hold.view().locked).toBe(false);
    expect(silent.hold.view().notice).toBe("I did not hear anything. Tap Record to try again.");
    silent.hold.press();
    expect(silent.speech).toHaveLength(3);
    expect(silent.recorders).toHaveLength(0);
  });

  it("keeps the native listener after two empty endings, retaining earlier words", () => {
    const silent = harness();
    silent.hold.press();
    silent.speech[0].onEnd();
    silent.speech[1].onEnd();
    expect(silent.hold.view().locked).toBe(false);
    expect(silent.hold.view().notice).toBe("I did not hear anything. Tap Record to try again.");
    silent.hold.press();
    expect(silent.speech).toHaveLength(3);
    expect(silent.recorders).toHaveLength(0);

    const heard = harness();
    heard.hold.press();
    heard.speech[0].onSegment({ text: "saved words", final: false });
    heard.speech[0].onEnd();
    heard.speech[1].onEnd();
    expect(heard.box.value).toBe("saved words");
    expect(heard.hold.view().locked).toBe(false);
    heard.hold.press();
    expect(heard.speech).toHaveLength(3);
  });

  it("preserves visible transcript on cancellation and typed whitespace on completion", () => {
    const h = harness();
    h.box.value = "Typed\n";
    h.hold.press();
    const handler = h.speech[0];
    handler.onSegment({ text: "visible words", final: false });
    expect(h.box.value).toBe("Typed\nvisible words");
    h.hold.cancel();
    handler.onSegment({ text: "late", final: true });
    expect(h.box.value).toBe("Typed\nvisible words");
    expect(h.hold.view().locked).toBe(false);

    h.box.value = "  another draft\n";
    h.hold.press();
    h.speech[1].onSegment({ text: "spoken", final: true });
    h.hold.release();
    expect(h.box.value).toBe("  another draft\nspoken");
  });

  it("keeps partial speech after a provider failure and ignores late callbacks", () => {
    const h = harness();
    h.box.value = "typed ";
    h.hold.press();
    const handler = h.speech[0];
    handler.onSegment({ text: "partly heard", final: false });
    handler.onError("network");
    expect(h.box.value).toBe("typed partly heard");
    expect(h.hold.view().locked).toBe(false);
    handler.onSegment({ text: "late", final: true });
    expect(h.box.value).toBe("typed partly heard");
  });

  it("keeps the draft and ignores callbacks after permission is denied", () => {
    const h = harness();
    h.box.value = "typed";
    h.hold.press();
    const handler = h.speech[0];
    handler.onError("not-allowed");
    expect(h.box.value).toBe("typed");
    expect(h.hold.view().notice).toBe(PERMISSION_COPY);
    handler.onSegment({ text: "late", final: true });
    expect(h.box.value).toBe("typed");
  });

  it("cancels a pending recorder permission request after a rapid second tap", async () => {
    const h = harness();
    h.recorderOnly();
    h.pendingPermission();
    h.box.value = "draft";
    h.hold.press();
    expect(h.hold.view().locked).toBe(true);
    h.hold.release();
    expect(h.hold.view().locked).toBe(false);
    h.allowPermission();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.recorders[0].cancel).toHaveBeenCalledOnce();
    h.mics[0].onFailure("permission-denied", "late failure");
    expect(h.box.value).toBe("draft");
    expect(h.hold.view().notice).toBeNull();
  });

  it("isolates a new recording from stale callbacks and cancellation", () => {
    const h = harness();
    h.hold.press();
    const first = h.speech[0];
    h.hold.cancel();
    h.hold.press();
    first.onSegment({ text: "stale", final: true });
    first.onError("not-allowed");
    expect(h.box.value).toBe("");
    expect(h.hold.view().listening).toBe(true);
    h.speech[1].onSegment({ text: "new", final: true });
    h.hold.release();
    expect(h.box.value).toBe("new");
  });

  it("keeps the recorder's ceiling clip, even before a Stop tap", async () => {
    const h = harness();
    h.recorderOnly();
    h.hold.press();
    await Promise.resolve();
    h.mics[0].onElapsed?.(30);
    expect(h.hold.view().secondsLeft).toBe(0);
    h.mics[0].onClip(new Blob(["voice"]));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.transcribe).toHaveBeenCalledOnce();
    expect(h.box.value).toBe("from clip");
    expect(h.hold.view().locked).toBe(false);
  });

  it("stays locked while a ceiling clip is transcribing", async () => {
    const h = harness();
    h.recorderOnly();
    let finish: ((value: { ok: true; text: string; ms: number }) => void) | undefined;
    h.transcribe.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    h.hold.press();
    await Promise.resolve();
    h.mics[0].onElapsed?.(30);
    h.mics[0].onClip(new Blob(["voice"]));
    expect(h.hold.view()).toMatchObject({ busy: true, locked: true, secondsLeft: 30 });
    h.hold.release();
    expect(h.transcribe).toHaveBeenCalledOnce();
    finish?.({ ok: true, text: "heard at limit", ms: 1 });
    await Promise.resolve();
    expect(h.box.value).toBe("heard at limit");
    expect(h.hold.view().locked).toBe(false);
  });
});
