/**
 * The capture sheet reuses the coach's tap controller with `timingPath: null`: its dictation must
 * neither file a `dictation` step on the coach's run nor discard a coach run in flight. The
 * coach composer keeps the default and still files on `coach-turn`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const timing = vi.hoisted(() => ({ markMs: vi.fn(), discardRun: vi.fn() }));
vi.mock("@/lib/timing", () => timing);

import { HoldController } from "@/lib/coach/hold";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import type { TimingPath } from "@/lib/timing";

function tapOnce(timingPath?: TimingPath | null): { box: { value: string } } {
  const box = { value: "" };
  const speech: SpeechHandlers[] = [];
  const ports = {
    listen: (handlers: SpeechHandlers) => { speech.push(handlers); return { stop: vi.fn(), abort: vi.fn() } as SpeechSession; },
    record: async () => null,
    transcribe: async () => ({ ok: true as const, text: "", ms: 0 }),
    readBox: () => box.value,
    writeBox: (value: string) => { box.value = value; },
    publish: vi.fn(),
  } satisfies ConstructorParameters<typeof HoldController>[0];
  const hold = timingPath === undefined ? new HoldController(ports)
    : new HoldController(ports, timingPath);
  hold.press();
  speech[0].onAudioStart?.();
  speech[0].onSegment({ text: "a turkey sandwich", final: true });
  hold.release();
  speech[0].onEnd();
  // A second tap that hears nothing is abandoned — the path that discards a run.
  hold.press();
  speech[1].onError("not-allowed");
  return { box };
}

beforeEach(() => { timing.markMs.mockReset(); timing.discardRun.mockReset(); });

describe("HoldController timing path", () => {
  it("files dictation on coach-turn by default", () => {
    const { box } = tapOnce();
    expect(box.value).toBe("a turkey sandwich");
    expect(timing.markMs).toHaveBeenCalledWith("coach-turn", "dictation", expect.any(Number));
    expect(timing.discardRun).toHaveBeenCalledWith("coach-turn");
  });

  it("files and discards nothing when the path is null", () => {
    const { box } = tapOnce(null);
    expect(box.value).toBe("a turkey sandwich");
    expect(timing.markMs).not.toHaveBeenCalled();
    expect(timing.discardRun).not.toHaveBeenCalled();
  });
});
