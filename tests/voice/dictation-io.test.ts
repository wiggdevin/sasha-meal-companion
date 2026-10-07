/**
 * Which listener a tap on either mic gets (lib/voice/dictation-io.ts). A browser tab: the
 * on-device recogniser first, then the recorder (`null`). The installed app: the recorder only,
 * because Web Speech is unreliable there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";

const { device, startListening } = vi.hoisted(() => {
  const session: SpeechSession = { stop: () => {}, abort: () => {} };
  return {
    device: session,
    startListening: vi.fn((_handlers: SpeechHandlers): SpeechSession | null => session),
  };
});
vi.mock("@/lib/coach/speech-api", () => ({ startListening }));
vi.mock("@/lib/capture-mic", () => ({ openMicRecorder: vi.fn() }));
vi.mock("@/lib/coach-transcribe-client", () => ({ transcribeClip: vi.fn() }));

const { dictationIo, isStandalone } = await import("@/lib/voice/dictation-io");
const handlers = {} as SpeechHandlers;

function standalone(on: boolean): void {
  vi.stubGlobal("matchMedia", () => ({ matches: on }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  startListening.mockClear();
});

describe("dictationIo().listen", () => {
  it("a browser tab: the on-device recogniser", () => {
    standalone(false);
    expect(dictationIo().listen(handlers)).toBe(device);
    expect(startListening).toHaveBeenCalledWith(handlers);
  });

  it("a browser tab with no recogniser: the recorder", () => {
    standalone(false);
    startListening.mockReturnValueOnce(null);
    expect(dictationIo().listen(handlers)).toBeNull();
  });

  it("the installed app: the recorder, never the recogniser", () => {
    standalone(true);
    expect(dictationIo().listen(handlers)).toBeNull();
    expect(startListening).not.toHaveBeenCalled();
  });
});

describe("isStandalone", () => {
  it("reads display-mode and iOS navigator.standalone", () => {
    const mm = (matches: boolean) => () => ({ matches });
    expect(isStandalone({ matchMedia: mm(true) })).toBe(true);
    expect(isStandalone({ matchMedia: mm(false), navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ matchMedia: mm(false), navigator: {} })).toBe(false);
    expect(isStandalone({})).toBe(false);
  });
});
