"use client";

/**
 * The weigh-in's follow-ups (U19): what the card morphs into once a weight is logged. Undo for its
 * window (the ring drains over it), "Your trend" and "Suggestions", which ask the assistant. Split
 * out of WeighInField.tsx, which owns the entry, the write and the undo window's timing.
 */
import type { CSSProperties, ReactNode, Ref } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import Button, { type ButtonStatus } from "@/components/ui/Button";
import CloseButton from "@/components/ui/CloseButton";
import { WEIGH_IN_UNDO_MS } from "@/components/coach/attachments/weigh-in";
import { SWAP, fade } from "@/lib/design/motion";
import styles from "./WeighInField.module.css";

export const TREND_ASK = "Show my weight trend";
export const SUGGESTIONS_ASK = "What do you suggest after today's weigh-in?";

/** One side of the swap (the entry or the follow-ups, or Undo): it blurs in and out (SWAP), and on
 *  its way out it is already gone for assistive tech, the keyboard and taps. The ref is popLayout's,
 *  which lifts the leaving side out of the flow while the other arrives. */
export function Swapped({ children, className, inline = false, ref }: {
  children: ReactNode; className?: string; inline?: boolean; ref?: Ref<HTMLElement>;
}) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const props = { initial: reduce ? false : SWAP.hidden, animate: SWAP.shown, exit: SWAP.hidden,
    transition: fade("base", reduce), className, inert: !present, "aria-hidden": present ? undefined : true } as const;
  return inline ? <motion.span ref={ref as Ref<HTMLSpanElement>} {...props}>{children}</motion.span>
    : <motion.div ref={ref as Ref<HTMLDivElement>} {...props}>{children}</motion.div>;
}

/** Undo's time left: a ring that drains over the undo window (reduced motion: a still ring). */
function UndoRing() {
  return <svg className={styles.ring} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6" pathLength={1} className={styles.ringTrack} />
    <circle cx="8" cy="8" r="6" pathLength={1} className={styles.ringLeft} />
  </svg>;
}
export function WeighInFollowUps({ shown, note, undoOpen, undoRef, trendRef, undoStatus, onUndo, onAsk, onClose }: {
  shown: string | undefined;
  note: string | null | undefined;
  undoOpen: boolean;
  undoRef: Ref<HTMLButtonElement>;
  trendRef: Ref<HTMLButtonElement>;
  undoStatus: ButtonStatus;
  onUndo: () => void;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  return <>
    <p role="status" className={`m-0 text-body font-medium text-charcoal ${styles.done}`}>
      <span className={styles.tick} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.4 6.6 11.4 12.5 4.8" /></svg>
      </span>
      Logged {shown}
      {undoOpen && <span className="sr-only">. Undo stays for {WEIGH_IN_UNDO_MS / 1000} seconds.</span>}
    </p>
    {note && <p className="m-0 text-tiny text-muted">{note}</p>}
    <div className={styles.actions}>
      <AnimatePresence initial={false} mode="popLayout">
        {/* Undo is a ghost action (Kimi K3: an underline read as a link); the time it has left
            drains round the ring before its label instead. */}
        {undoOpen && <Swapped key="undo" inline>
          <Button ref={undoRef} variant="ghost" size="sm" leading={<UndoRing />}
            status={undoStatus} confirmLabel="Undone" errorLabel="Try again" onClick={onUndo}
            style={{ "--undo-window": `${WEIGH_IN_UNDO_MS}ms` } as CSSProperties}>Undo</Button>
        </Swapped>}
      </AnimatePresence>
      <Button ref={trendRef} variant="secondary" size="sm"
        onClick={() => onAsk(TREND_ASK)}>Your trend</Button>
      <Button variant="secondary" size="sm" onClick={() => onAsk(SUGGESTIONS_ASK)}>Suggestions</Button>
    </div>
    <CloseButton label="Close weigh-in" onClick={onClose} className={styles.close} />
  </>;
}
