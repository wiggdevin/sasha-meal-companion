"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import CardFrame from "@/components/ui/CardFrame";
import Button from "@/components/ui/Button";
import { formatMacro } from "@/components/nutrition/spec";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { NextMeal } from "@/lib/today/board";
import type { OverviewControl, OverviewWhen } from "@/components/today/overview/types";
import type { SlotId } from "@/lib/types";
import styles from "@/components/today/overview/OverviewFace.module.css";

/** A tap this soon after the next meal changed was meant for the check that just left. */
export const SETTLE_MS = 400;

/** "13:30" → "1:30 PM". */
function clock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** "2 of 4 meals"; nothing when the eaten count is not known. */
export function mealProgress(eaten: number | undefined, planned: number): string | null {
  if (eaten === undefined || planned <= 0) return null;
  return `${Math.min(eaten, planned)} of ${planned} ${planned === 1 ? "meal" : "meals"}`;
}

function CheckIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
}

/** While the leaving meal animates away it is already gone for assistive tech, the keyboard and taps. */
function Leaving({ children, className, ...motionProps }: React.ComponentProps<typeof motion.div>) {
  const present = useIsPresent();
  return <motion.div className={className} inert={!present} aria-hidden={present ? undefined : true} {...motionProps}>
    {children}
  </motion.div>;
}

/** The progress segments: one per planned meal, the eaten ones filled. */
function Segments({ eaten, planned }: { eaten: number; planned: number }) {
  const count = Math.min(planned, 8);
  return <span className={styles.segments} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span key={index} className={styles.segment}
      data-done={index < eaten || undefined} />)}
  </span>;
}

/**
 * The cockpit's meals block (UI makeover §4 item 2, §11): how many of the day's planned meals are
 * eaten ("2 of 4 meals"), and the next one with its time, name, calories and protein. A tap opens
 * that meal's card on Today; the 44 px check marks it eaten, ignoring a second tap that lands within
 * SETTLE_MS of the next meal sliding in. With nothing next it says the day's meals are all eaten, or
 * that none are planned, never a scolding.
 */
export default function NextMealRow({ next, planned, eaten, when, onMarkEaten, markEatenControl, onOpenSlot }: {
  next: NextMeal | null;
  planned: number;
  /** Planned meals already eaten; undefined when not known (no count is shown then). */
  eaten?: number;
  when: OverviewWhen;
  onMarkEaten?: (slot: NextMeal["slot"]) => void;
  markEatenControl?: (slot: NextMeal["slot"]) => OverviewControl;
  onOpenSlot?: (slot: SlotId) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const changedAt = useRef<number | null>(null);
  const shownSlot = useRef(next?.slot ?? null);
  useEffect(() => {
    const slot = next?.slot ?? null;
    if (slot !== shownSlot.current) { shownSlot.current = slot; changedAt.current = performance.now(); }
  }, [next?.slot]);
  const markEaten = (slot: NextMeal["slot"]) => {
    if (changedAt.current !== null && performance.now() - changedAt.current < SETTLE_MS) return;
    onMarkEaten?.(slot);
  };
  const open = (slot: SlotId) => {
    if (onOpenSlot) { onOpenSlot(slot); return; }
    document.querySelector<HTMLElement>(`[data-slot-card="${slot}"]`)
      ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  };
  const progress = mealProgress(eaten, planned);
  const eyebrow = when === "today" ? "Next" : when === "past" ? "Still open" : "Coming up";

  return <CardFrame size="sm" as="section" aria-label="Meals">
    <div className={styles.mealsHead}>
      <span className={styles.overline}>{progress ?? "Meals"}</span>
      {eaten !== undefined && planned > 0 && <Segments eaten={eaten} planned={planned} />}
    </div>
    <AnimatePresence mode="popLayout" initial={false}>
      {next ? <Leaving key={next.slot} className={styles.next}
        initial={reduce ? false : { opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, x: -24, transition: FADES.quick }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <button type="button" className={`tap ${styles.nextOpen}`} onClick={() => open(next.slot)}
          aria-label={`${eyebrow}: ${next.name} at ${clock(next.time)}, ${formatMacro(next.kcal)} kcal. Open the meal`}>
          <span className={styles.thumb} aria-hidden="true">
            {next.image ? <Image src={next.image} alt="" fill sizes="48px" className={styles.thumbPhoto} /> : null}
          </span>
          <span className={styles.nextText} aria-hidden="true">
            <span className={styles.nextWhen}>{eyebrow} · {clock(next.time)}</span>
            <span className={styles.nextName}>{next.name}</span>
            <span className={styles.nextMeta}>
              <span className="kcal font-semibold">{formatMacro(next.kcal)}</span> kcal · {formatMacro(next.protein)} g protein
            </span>
          </span>
        </button>
        {onMarkEaten && <Button variant="primary" shape="circle" {...markEatenControl?.(next.slot)}
          className={markEatenControl?.(next.slot).className}
          aria-label={`Mark ${next.name} eaten`} onClick={() => markEaten(next.slot)}>
          <CheckIcon />
        </Button>}
      </Leaving> : <motion.div key="none" className={styles.next}
        initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <span className={styles.doneMark} aria-hidden="true"><CheckIcon /></span>
        <span className={styles.nextMeta}>
          {planned > 0 ? "Every planned meal on this day is eaten." : "No meals are planned for this day."}
        </span>
      </motion.div>}
    </AnimatePresence>
  </CardFrame>;
}
