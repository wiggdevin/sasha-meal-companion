"use client";

import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { spring } from "@/lib/design/motion";

/**
 * A region whose height follows its content on the `smooth` spring instead of snapping: search
 * results arriving, "Searching…" giving way to rows, an error line appearing. The Add pop-up's
 * results sit in one, so the card grows and settles rather than jumping (owner, 2026-10-04: "it's a
 * bit jumpy right now"). `className` reserves a floor (a min height) so the common case — a few
 * results — never changes the card's size at all.
 *
 * The 6 px inset and matching negative margin keep row shadows and focus rings inside the clip, the
 * same trick `.sheet-body` uses. Reduced motion: the height simply arrives.
 */
export default function AutoHeight({ className = "", children }: { className?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");

  useLayoutEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div data-auto-height className={`-m-1.5 overflow-hidden ${className}`.trim()} initial={false}
      animate={{ height }} transition={spring("smooth", reduce)}>
      <div ref={inner} className="p-1.5">{children}</div>
    </motion.div>
  );
}
