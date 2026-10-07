/**
 * The regression panel round 1 found on a real browser: no hold ever started.
 *
 * `components/CoachChat.tsx` passes the mic its callbacks as inline arrows, so they are new on
 * every parent render. The controller was built in a `useMemo` keyed on them, so the press —
 * which publishes `listening`, which sets state in the parent, which re-renders — rebuilt the
 * controller and cancelled the session it had just started. Zero transcript, no card.
 *
 * This drives the same sequence with the real controller: build once, refresh the callbacks the
 * way the component's effect does after every render, and check that one tap still reaches one
 * recogniser and lands its words once — through the newest callbacks, not the ones it was built
 * with.
 */
import { describe, expect, it, vi } from "vitest";
import { HoldController } from "@/lib/coach/hold";
import { latestCallbackPorts, type HoldCallbacks } from "@/lib/coach/hold-ports";
import type { SpeechHandlers, SpeechSession } from "@/lib/coach/speech-api";
import type { MicRecorder } from "@/lib/capture-mic";
import { FINALISE_MS } from "@/lib/coach/dictation";

function rig() {
  let at = 1_000;
  const timers = new Map<number, { fn: () => void; due: number }>();
  let next = 1;
  const listens: SpeechHandlers[] = [];
  const box = { value: "" };
  /** Every box write, tagged with which render's callback took it. */
  const writes: string[] = [];
  let renders = 0;

  const built = latestCallbackPorts(
    { readBox: () => box.value, writeBox: () => {}, publish: () => {} },
    {
      listen: (handlers) => {
        listens.push(handlers);
        return { stop: () => {}, abort: () => {} } as SpeechSession;
      },
      record: async () => ({ mimeType: "audio/mp4", stop: () => {}, cancel: () => {} } as MicRecorder),
      transcribe: async () => ({ ok: true as const, text: "", ms: 0 }),
    },
    {
      now: () => at,
      setTimer: (fn: () => void, ms: number) => { timers.set(next, { fn, due: at + ms }); return next++; },
      clearTimer: (handle: unknown) => { timers.delete(handle as number); },
    },
  );
  const hold = new HoldController(built.ports);

  /**
   * One parent render, exactly as `CoachMic`'s effect does it: brand-new arrow functions for
   * every callback, handed to the SAME controller.
   */
  const render = (): void => {
    renders += 1;
    const mine = renders;
    built.update({
      readBox: () => box.value,
      writeBox: (text) => { box.value = text; writes.push(`r${mine}:${text}`); },
      // Publishing is what made the parent re-render in the first place.
      publish: () => { render(); },
    } as HoldCallbacks);
  };
  render();

  return {
    hold, listens, box, writes, render,
    renders: () => renders,
    tick(ms: number) {
      at += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= at) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

describe("latestCallbackPorts", () => {
  it("reads the newest callbacks, never the ones it was built with", () => {
    const first = { readBox: () => "first", writeBox: vi.fn(), publish: vi.fn() };
    const built = latestCallbackPorts(first, {
      listen: () => null, record: async () => null, transcribe: async () => ({ ok: true, text: "", ms: 0 }),
    });
    expect(built.ports.readBox()).toBe("first");
    const second = { readBox: () => "second", writeBox: vi.fn(), publish: vi.fn() };
    built.update(second);
    expect(built.ports.readBox()).toBe("second");
    built.ports.writeBox("hello");
    expect(second.writeBox).toHaveBeenCalledWith("hello");
    expect(first.writeBox).not.toHaveBeenCalled();
  });

  it("hands back the same ports object every time, so a controller can be built once", () => {
    const built = latestCallbackPorts(
      { readBox: () => "", writeBox: vi.fn(), publish: vi.fn() },
      { listen: () => null, record: async () => null, transcribe: async () => ({ ok: true, text: "", ms: 0 }) },
    );
    const before = built.ports;
    built.update({ readBox: () => "x", writeBox: vi.fn(), publish: vi.fn() });
    expect(built.ports).toBe(before);
  });
});

describe("a tap under a parent that re-renders on every publish", () => {
  it("still reaches exactly one recogniser", () => {
    const r = rig();
    r.hold.press();
    // The press published, which re-rendered the parent; the old code rebuilt the controller here.
    expect(r.renders()).toBeGreaterThan(1);
    expect(r.listens).toHaveLength(1);
    expect(r.hold.view().listening).toBe(true);
  });

  it("settles once on Stop, through the callbacks of the render that was current", () => {
    const r = rig();
    r.hold.press();
    r.listens[0].onAudioStart?.();
    r.listens[0].onSegment({ text: "Add watermelon to my avoid list.", final: true });
    r.hold.release();
    r.tick(FINALISE_MS);
    expect(r.box.value).toBe("Add watermelon to my avoid list.");
    expect(r.hold.view().locked).toBe(false);
    const last = r.writes[r.writes.length - 1];
    expect(last).toMatch(/^r\d+:Add watermelon to my avoid list\.$/);
    // Not the first render's writeBox: the parent has re-rendered several times by now.
    expect(last).not.toMatch(/^r1:/);
  });

  it("writes the live transcript through the newest writeBox", () => {
    const r = rig();
    r.hold.press();
    r.listens[0].onAudioStart?.();
    r.listens[0].onSegment({ text: "add water", final: false });
    expect(r.box.value).toBe("add water");
  });
});
