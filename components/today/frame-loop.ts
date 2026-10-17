/**
 * A requestAnimationFrame loop that sleeps (battery). `step` draws one frame and answers whether
 * the water is still moving; once it says no, no frame is requested until `wake()` — a splash, a
 * new level, a tilt. A hidden page sleeps too and picks up again when it is shown, if it had not
 * settled. The caller draws its settled frame inside the `step` that returns false.
 */
export type FrameLoop = {
  /** Something disturbed the water: run again (a no-op while running; waits for a hidden page). */
  wake(): void;
  stop(): void;
};

export function runFrames(step: (now: number) => boolean): FrameLoop {
  let frame = 0;
  let running = false;
  let settled = false;
  let stopped = false;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const tick = (now: number) => {
    running = false;
    if (stopped) return;
    if (!step(now)) { settled = true; return; }
    running = true;
    frame = requestAnimationFrame(tick);
  };
  const start = () => {
    if (running || stopped || hidden()) return;
    running = true;
    frame = requestAnimationFrame(tick);
  };
  const onVisibility = () => {
    if (hidden()) {
      if (running) { cancelAnimationFrame(frame); running = false; }
    } else if (!settled) start();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  start();
  return {
    wake() { settled = false; start(); },
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      running = false;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
