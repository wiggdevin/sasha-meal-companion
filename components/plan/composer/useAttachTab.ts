"use client";
/**
 * The "+" tab's open state and the ways it closes: "+" again, a file chosen, Escape, or a tap
 * outside the ask box. Escape is answered here and stopped, so the sheet around the box stays open.
 * Focus goes back to "+" on every close except a tap outside, where it belongs to what was tapped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

export function useAttachTab(boundary: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    function down(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && boundary.current?.contains(target)) return;
      close(false);
    }
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open, boundary, close]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    close(true);
  }

  return { open, toggleRef, toggle: () => setOpen((was) => !was), close, onKeyDown };
}

/** The element's size, kept current while it lives (0 × 0 until it has been laid out). */
export function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Measured before paint, so the SVG body replaces the CSS one without a visible frame between.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => {
      // Layout size, not the painted box: a sheet still scaling in must not skew the outline.
      const next = { width: node.offsetWidth, height: node.offsetHeight };
      setSize((was) => was.width === next.width && was.height === next.height ? was : next);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
