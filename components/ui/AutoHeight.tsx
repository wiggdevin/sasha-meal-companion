"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotionConfig, type AnimationPlaybackControls } from "motion/react";
import { SPRINGS, type SpringName } from "@/lib/design/motion";

/** A change this small between two measurements is content already animating its own height; the
 *  box follows it exactly instead of chasing it on a spring. */
const FOLLOW_PX = 40;

/**
 * A box whose height follows its content (DESIGN.md §Motion: containers grow, they never jump). The
 * content is measured as it lays out. A sudden change (a layout switch, content swapped for other
 * content) springs; a gradual one (a child growing on its own) is followed frame by frame, so two
 * animations never fight. The box clips only while it travels: at rest a focus ring, a selected chip's
 * shadow or a button's glow inside it is never cut at its edge (owner, 2026-10-04: "highlights must
 * never be clipped by a card"). Under reduced motion it takes each new height at once.
 */
export default function AutoHeight({ children, className, spring = "smooth" }: {
  children: ReactNode;
  className?: string;
  spring?: SpringName;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const inner = useRef<HTMLDivElement | null>(null);
  const height = useMotionValue(0);
  const [measured, setMeasured] = useState(false);
  const [travelling, setTravelling] = useState(false);
  const springName = useRef(spring);
  const reduceRef = useRef(reduce);
  useLayoutEffect(() => { springName.current = spring; reduceRef.current = reduce; }, [spring, reduce]);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    let last = el.offsetHeight;
    let running: AnimationPlaybackControls | null = null;
    height.jump(last);
    setMeasured(true);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      const next = el.offsetHeight;
      if (next === last) return;
      const sudden = Math.abs(next - last) > FOLLOW_PX;
      last = next;
      if (reduceRef.current || (!sudden && !running)) {
        running?.stop(); running = null; setTravelling(false); height.jump(next); return;
      }
      // Retarget with the box's own speed. Stopping and restarting from rest on every measurement
      // made a card that grew while its spring ran stutter frame by frame (2026-10-01, #303).
      const velocity = height.getVelocity();
      running?.stop();
      setTravelling(true);
      running = animate(height, next, { ...SPRINGS[springName.current], velocity,
        onComplete: () => { running = null; setTravelling(false); } });
    });
    observer.observe(el);
    return () => { observer.disconnect(); running?.stop(); };
  }, [height]);

  // `clip`, not `hidden`: a hidden box can still be scrolled by the browser, and focusing a control
  // inside it (a recipe's ingredient checkbox) scrolled its content up out of sight (owner, 2026-10-04).
  return <motion.div className={className} data-travelling={travelling || undefined}
    style={{ overflow: travelling ? "clip" : "visible", height: measured ? height : "auto" }}>
    <div ref={inner} className="flow-root">{children}</div>
  </motion.div>;
}
