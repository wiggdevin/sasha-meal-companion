"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import AutoHeight from "@/components/ui/AutoHeight";
import { SproutFigure } from "@/components/today/island/SproutFigure";
import { MASCOTS, type MascotKey } from "@/components/today/island/mascots";
import TourDemo from "@/components/tour/TourDemos";
import { TourIcon } from "@/components/tour/TourIcons";
import { TOUR_STEPS } from "@/components/tour/tour-steps";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import { isSheetCloseKey, nextTrapFocus } from "@/lib/dom/sheet-a11y";
import { lockBodyScroll } from "@/lib/dom/scroll-lock";
import styles from "@/components/tour/AppTour.module.css";

export type TourCloseReason = "skip" | "done" | "escape";

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the sheet grows from: the centre of `origin` against the centre of the screen. */
function originOffset(origin: DOMRect | null | undefined): { x: number; y: number } {
  if (!origin || typeof window === "undefined") return { x: 0, y: 120 };
  return {
    x: origin.left + origin.width / 2 - window.innerWidth / 2,
    y: origin.top + origin.height / 2 - window.innerHeight / 2,
  };
}

/**
 * "How Sasha works", the first-run overview (owner, 2026-10-08). A modal sheet that grows out of the
 * companion that opened it (or rises from below when it opened by itself) on the gentle spring and
 * folds back into it on close. Five steps, each an animated demo over a drawn meal card and a few
 * short lines; Back and Next move between them (and the arrow keys), the dots show where you are,
 * Skip is always there and Escape closes. Focus moves into the sheet, stays in it, and returns to
 * whatever had it before. Reduced motion: no movement anywhere; every demo is a still frame.
 */
export default function AppTour({ onClose, origin, mascot = "sprout", returnFocusTo }: {
  onClose: (reason: TourCloseReason) => void;
  /** The box the sheet grows out of (the companion in the well). */
  origin?: DOMRect | null;
  mascot?: MascotKey;
  /** Focus goes here on close when nothing else held it before (a tap on iOS focuses nothing). */
  returnFocusTo?: HTMLElement | null;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const [from] = useState(() => originOffset(origin));
  const titleId = useId();
  const leadId = useId();

  const current = TOUR_STEPS[step];
  const last = step === TOUR_STEPS.length - 1;
  const name = MASCOTS[mascot].name;

  const go = (delta: 1 | -1) => {
    const next = step + delta;
    if (next < 0) return;
    if (next >= TOUR_STEPS.length) { onClose("done"); return; }
    setDirection(delta);
    setStep(next);
    // Back leaves the row on the first step: focus would fall out of the sheet, so Next takes it.
    if (next === 0) requestAnimationFrame(() => nextRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => lockBodyScroll(document.body), []);

  // Focus in on open, kept in, back on close (the Sheet's own rules, lib/dom/sheet-a11y.ts). A layout
  // effect, so the cleanup still sees focus inside the sheet.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    const returnTo = active && active !== document.body && !root.contains(active) ? active : returnFocusTo ?? null;
    nextRef.current?.focus({ preventScroll: true });
    const focusable = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    function onKeyDown(e: KeyboardEvent) {
      if (isSheetCloseKey(e.key)) { e.preventDefault(); onCloseRef.current("escape"); return; }
      if (e.key === "Tab") {
        const next = nextTrapFocus(focusable(), document.activeElement as HTMLElement | null, e.shiftKey);
        if (next) { e.preventDefault(); next.focus(); }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // What opened it may have gone (the companion's bubble): then the companion takes focus back.
      const target = returnTo?.isConnected ? returnTo : returnFocusTo?.isConnected ? returnFocusTo : null;
      target?.focus({ preventScroll: true });
    };
    // Runs once per opened sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Left and Right move between steps, except inside the gesture chips (their own row).
  const onArrow = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[role="group"]')) return;
    if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  };

  const slide = reduce ? INSTANT : SPRINGS.smooth;
  const stepBody = (
            <motion.div key={current.id} className="flex min-w-0 flex-col gap-4" data-step={current.id}
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 32 * direction }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0, transition: INSTANT }
                : { opacity: 0, x: -32 * direction, transition: { x: SPRINGS.snappy, opacity: { duration: 0.15 } } }}
              transition={reduce ? INSTANT : { x: slide, opacity: { duration: 0.2 } }}>
              <TourDemo kind={current.id} reduce={reduce} />
              <div className="flex items-center gap-3">
                <SproutFigure className={styles.guide} mascot={mascot} mood={current.pose} size={56} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-overline uppercase text-muted">{`${name} shows you · ${step + 1} of ${TOUR_STEPS.length}`}</span>
                  <h2 id={titleId} className="m-0 font-display text-heading font-light leading-none tracking-display-md text-charcoal">
                    {current.title}
                  </h2>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <p id={leadId} className="m-0 text-body font-normal leading-body-sm text-charcoal">{current.lead}</p>
                <ul className={`text-caption leading-body-sm text-graphite ${styles.points}`}>
                  {current.points.map((point) => typeof point === "string"
                    ? <li key={point} className={styles.point}>{point}</li>
                    : <li key={point.text} className={styles.iconPoint}>
                      <span className={`text-charcoal ${styles.pointIcon}`}><TourIcon name={point.icon} size={16} /></span>
                      <span>{point.text}</span>
                    </li>)}
                </ul>
              </div>
            </motion.div>
  );
  return <div ref={rootRef} className={`fixed inset-0 z-[75] min-w-0 w-full max-w-full ${styles.root}`}
    role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={leadId} onKeyDown={onArrow}>
    <motion.div aria-hidden="true" className="sheet-popover-scrim absolute inset-0"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.2 }} />
    <motion.div className={`sheet-surface min-w-0 ${styles.panel}`} data-tour-panel=""
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.3, x: from.x, y: from.y }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.12 } }
        : { opacity: 0, scale: 0.3, x: from.x, y: from.y, transition: { ...SPRINGS.smooth, opacity: { duration: 0.2, delay: 0.1 } } }}
      transition={reduce ? { duration: 0.16 } : { ...SPRINGS.gentle, opacity: { duration: 0.18 } }}>
      <div className="flex min-h-0 flex-col gap-4 px-4 pb-4 pt-3">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <div className={styles.dots} aria-hidden="true">
            {TOUR_STEPS.map((s, i) => <motion.span key={s.id} className={styles.dot} data-on={i === step || undefined}
              initial={false} animate={{ width: i === step ? 20 : 8 }}
              transition={reduce ? INSTANT : SPRINGS.snappy} />)}
          </div>
          <span className="sr-only" aria-live="polite">{`Step ${step + 1} of ${TOUR_STEPS.length}: ${current.title}`}</span>
          <Button variant="ghost" size="sm" onClick={() => onClose("skip")}>Skip</Button>
        </div>

        <div className={styles.scroller}>
        <AutoHeight spring="smooth">
          {/* Reduced motion swaps the step at once; otherwise the old one leaves before the new arrives. */}
          {reduce ? stepBody : <AnimatePresence mode="wait" initial={false} custom={direction}>{stepBody}</AnimatePresence>}
        </AutoHeight>
        </div>

        <div className="flex items-center gap-2">
          {step > 0 && <Button variant="tertiary" onClick={() => go(-1)}>Back</Button>}
          <Button ref={nextRef} variant="primary" className="flex-1" onClick={() => go(1)}>
            {last ? "Start using Sasha" : "Next"}
          </Button>
        </div>
      </div>
    </motion.div>
  </div>;
}
