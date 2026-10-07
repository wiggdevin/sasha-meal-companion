"use client";

import { useEffect, useState, type RefObject } from "react";

export const KEYBOARD_HEIGHT_DELTA = 120;

/** Keep the fixed chat shell inside iOS's visible viewport while its keyboard moves. */
export function useVisualViewport(shell: RefObject<HTMLElement | null>): boolean {
  const [isKeyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame: number | null = null;

    const apply = () => {
      frame = null;
      const element = shell.current;
      if (!element) return;
      element.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
      element.style.setProperty("--visual-viewport-offset-top", `${viewport.offsetTop}px`);
      setKeyboardOpen(window.innerHeight - viewport.height > KEYBOARD_HEIGHT_DELTA);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = -1;
      const requested = window.requestAnimationFrame(apply);
      if (frame !== null) frame = requested;
    };

    schedule();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      if (frame !== null && frame >= 0) window.cancelAnimationFrame(frame);
    };
  }, [shell]);

  return isKeyboardOpen;
}
