// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFrames as run, type FrameLoop } from "@/components/today/frame-loop";

const loops: FrameLoop[] = [];
const runFrames = (step: (now: number) => boolean) => { const loop = run(step); loops.push(loop); return loop; };

let queue: Array<(now: number) => void> = [];
const flush = (now = 0) => { const run = queue; queue = []; run.forEach((fn) => fn(now)); };
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  queue = [];
  visibility = "visible";
  vi.stubGlobal("requestAnimationFrame", (fn: (now: number) => void) => queue.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => { queue = []; });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => { loops.splice(0).forEach((loop) => loop.stop()); vi.unstubAllGlobals(); });

describe("runFrames", () => {
  it("keeps asking for frames while the step says the water is moving", () => {
    const step = vi.fn(() => true);
    runFrames(step);
    flush(); flush(); flush();
    expect(step).toHaveBeenCalledTimes(3);
    expect(queue).toHaveLength(1);
  });

  it("sleeps once settled and requests no further frame until woken", () => {
    let moving = true;
    const step = vi.fn(() => moving);
    const loop = runFrames(step);
    flush();
    moving = false;
    flush();
    expect(queue).toHaveLength(0);
    loop.wake();
    expect(queue).toHaveLength(1);
    loop.wake();
    expect(queue).toHaveLength(1);
  });

  it("sleeps while the page is hidden and resumes when shown, unless it had settled", () => {
    let moving = true;
    const loop = runFrames(() => moving);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue).toHaveLength(0);
    loop.wake();
    expect(queue).toHaveLength(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue).toHaveLength(1);
    moving = false;
    flush();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue).toHaveLength(0);
  });

  it("stops for good and ignores a later wake", () => {
    const step = vi.fn(() => true);
    const loop = runFrames(step);
    loop.stop();
    loop.wake();
    flush();
    expect(step).not.toHaveBeenCalled();
  });
});
