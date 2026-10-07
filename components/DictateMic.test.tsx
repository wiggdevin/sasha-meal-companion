/** @vitest-environment jsdom */
/**
 * The capture sheet's "Say or type" box: tap the mic, words stream into the box, tap again to
 * stop, and nothing is proposed until the user taps "Check it". Driven through the real
 * controller and speech adapter with a fake `SpeechRecognition`, so no microphone is needed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/capture-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture-client")>()),
  captureText,
}));

import CaptureSheet from "@/components/CaptureSheet";
import {
  dictationCopy, dictationStatus, MIC_OFF_COPY, MIC_UNAVAILABLE_COPY,
} from "@/components/DictateMic";
import { PERMISSION_COPY } from "@/lib/coach/dictation";
import type { HoldView } from "@/lib/coach/hold";

type Handler = ((event?: unknown) => void) | null;
class FakeRecognition {
  static made: FakeRecognition[] = [];
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 1;
  onresult: Handler = null; onerror: Handler = null; onend: Handler = null;
  onstart: Handler = null; onaudiostart: Handler = null;
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  constructor() { FakeRecognition.made.push(this); }
  say(text: string): void {
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

const noop = () => {};
const box = () => screen.getByRole("textbox", { name: "What you ate" }) as HTMLTextAreaElement;
const checkIt = () => screen.getByRole("button", { name: "Check it" }) as HTMLButtonElement;

function openText(): void {
  render(<CaptureSheet open initialMode="text" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
}

beforeEach(() => {
  FakeRecognition.made = [];
  captureText.mockReset();
  captureText.mockResolvedValue({ kind: "empty", message: "Nothing to check." });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dictation lines", () => {
  it("points a denied microphone at typing, and names the mic instead of Record", () => {
    expect(dictationCopy(PERMISSION_COPY)).toBe(MIC_OFF_COPY);
    expect(dictationCopy("I did not hear anything. Tap Record to try again."))
      .toBe("I did not hear anything. Tap the mic to try again.");
    expect(dictationCopy(null)).toBeNull();
  });

  it("says what the mic is doing, and nothing at rest", () => {
    const rest: HoldView = { locked: false, listening: false, recording: false, secondsLeft: 30,
      busy: false, settling: false, notice: null };
    expect(dictationStatus(rest)).toBeNull();
    expect(dictationStatus({ ...rest, locked: true, listening: true }))
      .toBe("Listening. Tap the mic when you are done.");
    expect(dictationStatus({ ...rest, locked: true, listening: true, recording: true, secondsLeft: 12 }))
      .toBe("Recording, 12 s left. Tap the mic to stop.");
    expect(dictationStatus({ ...rest, locked: true, busy: true })).toBe("Writing it down…");
  });
});

describe("Say or type", () => {
  it("dictates into the box, locks it while listening, and never proposes on its own", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    openText();
    const mic = screen.getByRole("button", { name: "Say what you ate" });
    expect(mic.style.width).toBe("44px");
    expect(mic.style.height).toBe("44px");

    fireEvent.click(mic);
    const recognition = FakeRecognition.made[0];
    expect(recognition.start).toHaveBeenCalledTimes(1);
    act(() => { recognition.onstart?.(); recognition.say("I had a turkey sandwich with cheese"); });

    expect(box().value).toBe("I had a turkey sandwich with cheese");
    expect(box().readOnly).toBe(true);
    expect(checkIt().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Listening. Tap the mic when you are done.");

    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    act(() => { recognition.onend?.(); });

    expect(box().value).toBe("I had a turkey sandwich with cheese");
    expect(box().readOnly).toBe(false);
    expect(checkIt().disabled).toBe(false);
    expect(captureText).not.toHaveBeenCalled();

    // The user reviews, edits, and sends it down the existing text propose path.
    fireEvent.change(box(), { target: { value: "I had a turkey sandwich with cheddar" } });
    await act(async () => { fireEvent.click(checkIt()); });
    expect(captureText).toHaveBeenCalledTimes(1);
    expect(captureText.mock.calls[0][0]).toBe("I had a turkey sandwich with cheddar");
  });

  it("appends to what was already typed", () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    openText();
    fireEvent.change(box(), { target: { value: "Lunch:" } });
    fireEvent.click(screen.getByRole("button", { name: "Say what you ate" }));
    const recognition = FakeRecognition.made[0];
    act(() => { recognition.onstart?.(); recognition.say("a turkey sandwich"); });
    expect(box().value).toBe("Lunch: a turkey sandwich");
  });

  it("falls back to typing with a short line when the microphone is denied", () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    openText();
    fireEvent.change(box(), { target: { value: "two eggs" } });
    fireEvent.click(screen.getByRole("button", { name: "Say what you ate" }));
    act(() => { FakeRecognition.made[0].onerror?.({ error: "not-allowed" }); });

    expect(screen.getByRole("status").textContent).toBe(MIC_OFF_COPY);
    expect(box().value).toBe("two eggs");
    expect(box().readOnly).toBe(false);
    expect(checkIt().disabled).toBe(false);
  });

  it("is a plain text box with a short line when this browser cannot dictate", () => {
    // jsdom has neither SpeechRecognition nor MediaRecorder.
    openText();
    expect(screen.queryByRole("button", { name: "Say what you ate" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(MIC_UNAVAILABLE_COPY);
    fireEvent.change(box(), { target: { value: "a turkey sandwich" } });
    expect(checkIt().disabled).toBe(false);
  });

  it("titles the sheet as speak-or-type", () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    openText();
    expect(screen.getByText("Say or type a meal")).toBeTruthy();
    expect(screen.getByText("Tap the mic and say what you ate, or type it.")).toBeTruthy();
  });
});
