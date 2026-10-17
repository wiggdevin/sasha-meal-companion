/**
 * T7 §1 to §3, one tap-to-record session at a time — panel round 1's HIGH list and Grok pass 2,
 * each with a test that fails without the fix. tests/coach/tap-dictation.test.ts covers the
 * draft, restart and ceiling rules; this file covers the edges around them.
 *
 * There is no DOM in this repo (no jsdom, no @testing-library; see
 * tests/speed/pending-card-copy.test.tsx's note), so the whole gesture lives in
 * `lib/coach/hold.ts` and is driven here with stub ports and a hand-cranked clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { HoldController, type HoldPorts, type HoldView } from "@/lib/coach/hold";
import { EMPTY_COPY, FINALISE_MS, SLOW_COPY } from "@/lib/coach/dictation";
import type { MicHandlers, MicRecorder } from "@/lib/capture-mic";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import { buffered, mark, measure, resetTimings } from "@/lib/timing";

/** A clock whose timers only fire when the test says so. */
function clock() {
  let at = 1_000;
  const timers = new Map<number, { fn: () => void; due: number }>();
  let next = 1;
  return {
    now: () => at,
    setTimer: (fn: () => void, ms: number) => { timers.set(next, { fn, due: at + ms }); return next++; },
    clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    tick(ms: number) {
      at += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= at) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

type Harness = {
  hold: HoldController;
  clock: ReturnType<typeof clock>;
  box: { value: string };
  views: HoldView[];
  speech: SpeechHandlers | null;
  sessions: { stopped: number; aborted: number }[];
  mic: MicHandlers | null;
  recorders: { stopped: number; cancelled: number }[];
  transcribed: Blob[];
  openRecorder: boolean;
  speechAvailable: boolean;
  /** `startListening` reports its own failure and answers null, which abandons the session. */
  listenFails: boolean;
  transcribe: (clip: Blob, signal?: AbortSignal) => Promise<{ ok: true; text: string; ms: number } | { ok: false; message: string }>;
};

function harness(overrides: Partial<HoldPorts> & { speechAvailable?: boolean } = {}): Harness {
  const time = clock();
  const box = { value: "" };
  const views: HoldView[] = [];
  const sessions: { stopped: number; aborted: number }[] = [];
  const recorders: { stopped: number; cancelled: number }[] = [];
  const transcribed: Blob[] = [];
  const h: Harness = {
    hold: null as never, clock: time, box, views, speech: null, sessions,
    mic: null, recorders, transcribed, openRecorder: true,
    speechAvailable: overrides.speechAvailable !== false, listenFails: false,
    transcribe: async (clip) => { transcribed.push(clip); return { ok: true, text: "typed by the server", ms: 10 }; },
  };
  h.hold = new HoldController({
    listen: (handlers) => {
      if (h.listenFails) { handlers.onError("not-allowed"); return null; }
      if (!h.speechAvailable) return null;
      h.speech = handlers;
      const session = { stopped: 0, aborted: 0 };
      sessions.push(session);
      return { stop: () => { session.stopped += 1; }, abort: () => { session.aborted += 1; } } as SpeechSession;
    },
    record: async (handlers) => {
      h.mic = handlers;
      if (!h.openRecorder) return null;
      const recorder = { stopped: 0, cancelled: 0 };
      recorders.push(recorder);
      return {
        mimeType: "audio/mp4",
        stop: () => { recorder.stopped += 1; },
        cancel: () => { recorder.cancelled += 1; },
      } as MicRecorder;
    },
    transcribe: (clip, signal) => h.transcribe(clip, signal),
    readBox: () => box.value,
    writeBox: (text) => { box.value = text; },
    publish: (view) => { views.push(view); },
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    ...overrides,
  });
  return h;
}

const latest = (h: Harness): HoldView => h.views[h.views.length - 1];

beforeEach(() => { resetTimings(); });

/** Start a session on the recogniser and hear `segments`, short of Stop. */
function speak(h: Harness, segments: { text: string; final: boolean }[]): void {
  h.hold.press();
  h.speech?.onAudioStart?.();
  for (const segment of segments) h.speech?.onSegment(segment);
  h.clock.tick(900);
}

/** Let the recorder's open, the transcribe call and its continuation run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

describe("a final that lands after Stop", () => {
  it("is still heard — the recogniser's handlers stay live until onend", () => {
    const h = harness();
    speak(h, [{ text: "add watermelon", final: false }]);
    h.hold.release();
    expect(h.sessions[0].stopped).toBe(1);
    // WebKit delivers the final AFTER stop(). It must reach the controller and the box.
    h.speech?.onSegment({ text: "add watermelon to my avoid list", final: true });
    h.speech?.onEnd();
    expect(h.box.value).toBe("add watermelon to my avoid list");
    expect(latest(h).locked).toBe(false);
    h.clock.tick(1_000);
    expect(h.box.value).toBe("add watermelon to my avoid list");
  });

  it("settles on onend rather than waiting out the 800 ms when nothing more comes", () => {
    const h = harness();
    speak(h, [{ text: "hello", final: false }]);
    h.hold.release();
    h.speech?.onEnd();
    expect(h.box.value).toBe("hello");
    expect(latest(h).locked).toBe(false);
  });
});

describe("the composer stays locked through finalising", () => {
  it("is locked from the press until the words land, and never in between", () => {
    const h = harness();
    speak(h, [{ text: "hello", final: false }]);
    h.hold.release();
    expect(latest(h).locked).toBe(true);
    expect(latest(h).settling).toBe(true);
    h.clock.tick(FINALISE_MS);
    expect(h.box.value).toBe("hello");
    expect(latest(h).locked).toBe(false);
  });
});

describe("the permission sheet", () => {
  it("says nothing at all when the microphone never opened", () => {
    const h = harness();
    h.hold.press();
    // Answering the sheet ends the session; audio never started and nothing was heard.
    h.hold.release();
    h.clock.tick(2_000);
    expect(latest(h).notice).toBeNull();
    expect(latest(h).locked).toBe(false);
    expect(h.sessions[0].aborted).toBe(1);
  });

  it("still shows the empty line for a real silent session", () => {
    const h = harness();
    h.hold.press();
    h.speech?.onAudioStart?.();
    h.clock.tick(900);
    h.hold.release();
    h.clock.tick(FINALISE_MS);
    expect(latest(h).notice).toBe(EMPTY_COPY);
  });

  it("says nothing when the recorder opens after Stop", async () => {
    const h = harness({ speechAvailable: false });
    h.hold.press();
    h.hold.release();
    await flush();
    expect(h.recorders[0]?.cancelled).toBe(1);
    expect(latest(h).notice).toBeNull();
  });

  it("puts back what she had typed when the session caught nothing", () => {
    const h = harness();
    h.box.value = "half a sentence";
    h.hold.press();
    h.speech?.onAudioStart?.();
    h.hold.release();
    h.clock.tick(FINALISE_MS);
    expect(h.box.value).toBe("half a sentence");
  });
});

describe("a draft already in the box (ruling R1)", () => {
  it("joins the fallback's transcript into the box rather than replacing her draft", async () => {
    const h = harness({ speechAvailable: false });
    h.box.value = "and a banana";
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await flush();
    expect(h.box.value).toBe("and a banana typed by the server");
  });
});

describe("the fallback's clip", () => {
  it("is always consumed once the recorder has finished, even if Stop came after", async () => {
    const h = harness({ speechAvailable: false });
    h.hold.press();
    await flush();
    // The 30 s ceiling ends the clip while the session is still open.
    h.mic?.onClip(new Blob(["bytes"]));
    h.hold.release();
    await flush();
    expect(h.transcribed).toHaveLength(1);
    expect(h.box.value).toBe("typed by the server");
  });

  it("locks the composer while it is being transcribed", async () => {
    const h = harness({ speechAvailable: false });
    let finish: (out: { ok: true; text: string; ms: number }) => void = () => {};
    h.transcribe = () => new Promise((resolve) => { finish = resolve as never; });
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await Promise.resolve();
    expect(latest(h).locked).toBe(true);
    expect(latest(h).busy).toBe(true);
    finish({ ok: true, text: "hello", ms: 1 });
    await flush();
    expect(latest(h).locked).toBe(false);
  });

  it("puts her typed words back and shows the slow line on a timeout", async () => {
    const h = harness({ speechAvailable: false });
    h.box.value = "half a sentence";
    h.transcribe = async () => ({ ok: false, message: SLOW_COPY });
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await flush();
    expect(latest(h).notice).toBe(SLOW_COPY);
    expect(h.box.value).toBe("half a sentence");
  });
});

describe("the dictation hop", () => {
  it("measures Stop to transcript, not press to transcript", () => {
    const h = harness();
    h.hold.press();
    h.clock.tick(5_000);
    h.speech?.onAudioStart?.();
    h.speech?.onSegment({ text: "hello", final: false });
    h.hold.release();
    h.clock.tick(400);
    h.speech?.onSegment({ text: "hello", final: true });
    h.speech?.onEnd();
    // Nothing is buffered until a run closes, so read it through the next turn's own measure.
    measure("coach-turn", "11111111-1111-4111-8111-111111111111");
    const row = buffered().find((r) => r.step === "dictation");
    expect(row?.ms).toBe(400);
  });
});

describe("leaving the page", () => {
  it("ends the session, drops the clip and unlocks the composer", async () => {
    const h = harness({ speechAvailable: false });
    h.box.value = "half a sentence";
    h.hold.press();
    await flush();
    h.hold.cancel();
    expect(h.recorders[0].cancelled).toBe(1);
    expect(latest(h).locked).toBe(false);
    expect(h.box.value).toBe("half a sentence");
  });
});

describe("a microphone that will not open", () => {
  it("says so once and leaves the composer usable", async () => {
    const h = harness({ speechAvailable: false });
    h.openRecorder = false;
    h.hold.press();
    await flush();
    h.mic?.onFailure("permission-denied", "Microphone access is off. Allow it in Settings, then try again.");
    expect(latest(h).notice).toMatch(/Microphone access is off/);
    expect(latest(h).locked).toBe(false);
  });
});

/** Grok pass 2. Each of these fails without its fix. */
describe("a continuation that outlived its session (H2)", () => {
  it("writes nothing when the session was cancelled while the POST was in flight", async () => {
    const h = harness({ speechAvailable: false });
    h.box.value = "half a sentence";
    let finish: (out: { ok: true; text: string; ms: number }) => void = () => {};
    h.transcribe = () => new Promise((resolve) => { finish = resolve as never; });
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await Promise.resolve();
    h.hold.cancel();
    const before = h.views.length;
    finish({ ok: true, text: "typed by the server", ms: 1 });
    await flush();
    expect(h.box.value).toBe("half a sentence");
    expect(h.views.length).toBe(before);
  });

  it("aborts the in-flight transcription when the session is cancelled", async () => {
    const h = harness({ speechAvailable: false });
    let seen: AbortSignal | undefined;
    h.transcribe = (_clip, signal) => { seen = signal; return new Promise(() => {}); };
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    h.hold.cancel();
    expect(seen?.aborted).toBe(true);
  });

  it("throws away a recorder that opened after the session was cancelled", async () => {
    const h = harness({ speechAvailable: false });
    h.hold.press();
    h.hold.cancel();
    await flush();
    expect(h.recorders[0].cancelled).toBe(1);
  });
});

describe("a second press while the last session is finalising (H3)", () => {
  it("is refused, and the first session still lands its words exactly once", () => {
    const h = harness();
    speak(h, [{ text: "add watermelon", final: false }]);
    h.hold.release();
    expect(latest(h).settling).toBe(true);
    h.hold.press();
    expect(h.sessions).toHaveLength(1);
    h.speech?.onSegment({ text: "add watermelon to my avoid list", final: true });
    h.speech?.onEnd();
    expect(h.box.value).toBe("add watermelon to my avoid list");
  });

  it("is allowed again once the words have landed", () => {
    const h = harness();
    speak(h, [{ text: "hello", final: true }]);
    h.hold.release();
    h.clock.tick(FINALISE_MS);
    expect(latest(h).settling).toBe(false);
    h.hold.press();
    expect(h.sessions).toHaveLength(2);
  });
});

describe("falling back to the recorder mid-session (H4)", () => {
  it("keeps the words the recogniser already gave, in front of the server's", async () => {
    const h = harness();
    h.hold.press();
    h.speech?.onAudioStart?.();
    h.speech?.onSegment({ text: "Change my 4th meal to", final: true });
    // Safari ends the session; the restart finds no recogniser at all, so §2 takes over.
    h.speechAvailable = false;
    h.speech?.onEnd();
    await Promise.resolve(); await Promise.resolve();
    h.transcribe = async () => ({ ok: true, text: "beef jerky and a Chobani yogurt", ms: 10 });
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await flush();
    expect(h.box.value).toBe("Change my 4th meal to beef jerky and a Chobani yogurt");
  });
});

describe("Stop while the microphone is still opening (M5)", () => {
  it("unlocks the composer instead of waiting for getUserMedia", () => {
    const h = harness({ speechAvailable: false });
    h.hold.press();
    h.hold.release();
    expect(latest(h).locked).toBe(false);
  });
});

describe("a recogniser that refuses to start (M7)", () => {
  it("does not open a second permission sheet on a session that is already over", async () => {
    const h = harness();
    h.listenFails = true;
    h.hold.press();
    await flush();
    expect(h.mic).toBeNull();
    expect(latest(h).locked).toBe(false);
  });
});

describe("dictation and the turn share one run (M8)", () => {
  it("on the on-device path", () => {
    const h = harness();
    speak(h, [{ text: "hello", final: true }]);
    h.hold.release();
    h.clock.tick(FINALISE_MS);
    // She reads it, then taps Send: the turn joins the run the dictation opened.
    mark("coach-turn", "sent");
    measure("coach-turn", "22222222-2222-4222-8222-222222222222");
    const steps = buffered().filter((r) => r.path === "coach-turn");
    expect(steps.map((r) => r.step).sort()).toEqual(["dictation", "sent"]);
    expect(new Set(steps.map((r) => r.run_id)).size).toBe(1);
  });

  it("on the fallback path, where her Send closes the run later", async () => {
    const h = harness({ speechAvailable: false });
    h.hold.press();
    await flush();
    h.hold.release();
    h.mic?.onClip(new Blob(["bytes"]));
    await flush();
    mark("coach-turn", "sent");
    measure("coach-turn", "33333333-3333-4333-8333-333333333333");
    const steps = buffered().filter((r) => r.path === "coach-turn");
    expect(steps.map((r) => r.step).sort()).toEqual(["dictation", "sent"]);
    expect(new Set(steps.map((r) => r.run_id)).size).toBe(1);
  });
});
