/**
 * T7 §1 and §3 — the tap-to-record state machine, without a browser.
 *
 * Every rule the spec puts a number on is here: the 800 ms finalise timer, the empty transcript,
 * and the three recognition errors that switch the session to the server fallback instead of
 * saying anything.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_COPY, EMPTY_MS, FINALISE_MS, NO_SPEECH_COPY, PERMISSION_COPY,
  SLOW_COPY, initialDictation, nextDictation, transcriptOf, type DictationEvent,
  type DictationState,
} from "@/lib/coach/dictation";
import { unsupportedCopy } from "@/components/VoiceCapture";

const run = (events: DictationEvent[], from = initialDictation()): DictationState =>
  events.reduce(nextDictation, from);

const session: DictationEvent[] = [{ type: "press" }, { type: "release" }];

describe("the copy", () => {
  it("takes the permission line from VoiceCapture rather than writing a second one", () => {
    expect(PERMISSION_COPY).toBe(unsupportedCopy("permission-denied"));
  });

  it("says each line once, with no exclamation mark", () => {
    for (const copy of [EMPTY_COPY, NO_SPEECH_COPY, PERMISSION_COPY, SLOW_COPY]) {
      expect(copy).not.toContain("!");
    }
    expect(EMPTY_COPY).toBe("I did not catch that. Tap Record to try again.");
    expect(NO_SPEECH_COPY).toBe("I did not hear anything. Tap Record to try again.");
    expect(SLOW_COPY).toBe("Transcribing is slow right now. Type it, or try again.");
  });

  it("keeps the spec's durations", () => {
    expect([FINALISE_MS, EMPTY_MS]).toEqual([800, 3_000]);
  });
});

describe("a session that speaks", () => {
  it("shows the interim segment after the final ones while listening", () => {
    const state = run([
      { type: "press" },
      { type: "segment", text: "add watermelon", final: true },
      { type: "segment", text: "to my avoid", final: false },
    ]);
    expect(state.phase).toBe("listening");
    expect(transcriptOf(state)).toBe("add watermelon to my avoid");
  });

  it("sends on release when a final has already landed and nothing is pending", () => {
    const state = run([
      { type: "press" },
      { type: "segment", text: "add watermelon to my avoid list", final: true },
      { type: "release" },
    ]);
    expect(state.phase).toBe("sent");
    expect(state.text).toBe("add watermelon to my avoid list");
  });

  it("waits in finalising when an interim is still pending, then sends on the final", () => {
    const held = run([
      { type: "press" },
      { type: "segment", text: "add watermelon", final: false },
      { type: "release" },
    ]);
    expect(held.phase).toBe("finalising");
    const settled = nextDictation(held, { type: "segment", text: "add watermelon", final: true });
    expect(settled.phase).toBe("sent");
    expect(settled.text).toBe("add watermelon");
  });

  it("sends what it has when the 800 ms finalise timer fires instead", () => {
    const held = run([
      { type: "press" },
      { type: "segment", text: "add watermelon", final: false },
      { type: "release" },
    ]);
    expect(nextDictation(held, { type: "finalised" })).toMatchObject({
      phase: "sent", text: "add watermelon",
    });
  });
});

describe("a session that says nothing", () => {
  it("waits in finalising after Stop, however short the session", () => {
    expect(run(session).phase).toBe("finalising");
  });

  it("shows the empty line for 3 s when a session produced no words", () => {
    const state = nextDictation(run(session), { type: "finalised" });
    expect(state.phase).toBe("empty");
    expect(state.text).toBe("");
    expect(state.notice).toEqual({ text: EMPTY_COPY, ms: EMPTY_MS });
  });

  it("treats whitespace as nothing said", () => {
    const state = run([
      { type: "press" }, { type: "segment", text: "   ", final: true },
      { type: "release" }, { type: "finalised" },
    ]);
    expect(state.phase).toBe("empty");
  });
});

describe("recognition errors", () => {
  it("shows the permission line for not-allowed, under either spelling", () => {
    for (const code of ["not-allowed", "NotAllowedError"]) {
      const state = run([{ type: "press" }, { type: "error", code }]);
      expect(state.phase).toBe("error");
      expect(state.notice?.text).toBe(PERMISSION_COPY);
      expect(state.fallback).toBe(false);
    }
  });

  it("shows the no-speech line for no-speech", () => {
    const state = run([{ type: "press" }, { type: "error", code: "no-speech" }]);
    expect(state.notice?.text).toBe(NO_SPEECH_COPY);
  });

  it("switches the session to the fallback silently for the three §3 errors", () => {
    for (const code of ["network", "service-not-allowed", "audio-capture"]) {
      const state = run([{ type: "press" }, { type: "error", code }]);
      expect(state.fallback).toBe(true);
      expect(state.notice).toBeNull();
      expect(state.phase).toBe("idle");
    }
  });

  it("ignores the abort our own stop() raises", () => {
    const listening = run([{ type: "press" }]);
    expect(nextDictation(listening, { type: "error", code: "aborted" })).toEqual(listening);
  });

  it("falls back rather than inventing copy for an error the spec does not name", () => {
    const state = run([{ type: "press" }, { type: "error", code: "language-not-supported" }]);
    expect(state.fallback).toBe(true);
    expect(state.notice).toBeNull();
  });

  it("keeps the fallback switch on across the next press", () => {
    const fell = run([{ type: "press" }, { type: "error", code: "network" }]);
    expect(nextDictation(fell, { type: "press" }).fallback).toBe(true);
  });
});

describe("settling", () => {
  it("returns to idle with the transcript dropped once the caller has consumed it", () => {
    const sent = run([
      { type: "press" }, { type: "segment", text: "hello", final: true },
      { type: "release" },
    ]);
    const idle = nextDictation(sent, { type: "settled" });
    expect(idle.phase).toBe("idle");
    expect(idle.text).toBe("");
    expect(transcriptOf(idle)).toBe("");
  });

  it("clears the notice when its own timer expires", () => {
    const empty = nextDictation(run(session), { type: "finalised" });
    expect(nextDictation(empty, { type: "notice_expired" }).notice).toBeNull();
  });

  it("clears a standing notice on the next press", () => {
    const empty = nextDictation(run(session), { type: "finalised" });
    expect(nextDictation(empty, { type: "press" }).notice).toBeNull();
  });

  it("ignores a release that never had a press", () => {
    expect(nextDictation(initialDictation(), { type: "release" }).phase).toBe("idle");
  });
});
