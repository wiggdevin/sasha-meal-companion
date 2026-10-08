"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FADES, SPRINGS } from "@/lib/design/motion";
import type { Macros } from "@/lib/types";
import { feedbackStateProps, type ActionFeedbackPhase } from "./ActionFeedback";
import styles from "./MealNutritionDivider.module.css";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function macroItems(macros: Macros) {
  return [
    { short: "P", name: "Protein", value: macros.protein, role: "macro-protein" },
    { short: "C", name: "Carbs", value: macros.carbs, role: "macro-carbs" },
    { short: "F", name: "Fat", value: macros.fat, role: "macro-fat" },
  ];
}

function CheckIcon({ filled }: { filled: boolean }) {
  const reduceMotion = useReducedMotion();
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" fill={filled ? "currentColor" : "none"} />
    {/* An open ring until the meal is eaten, so the zone never reads as already ticked; eaten, a
        solid disc with the tick cut into it in the zone's own fill colour. */}
    {filled && <motion.path data-tick="" className={styles.tick} d="m8 12.4 2.8 2.8L16.2 9.6" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
      initial={reduceMotion ? false : { pathLength: 0 }}
      animate={{ pathLength: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.23, 1, 0.32, 1] }} />}
  </svg>;
}

/** The meal's calorie total, set on the hero as a figure: the persimmon Fraunces numeral over its unit.
 *  Ticking the meal off is the labelled eaten button in the card's action strip (meal cards v2). */
export function MealCalories({ kcal }: { kcal: number }) {
  return <span data-meal-calories="true"
    className={`relative z-10 flex min-h-11 shrink-0 items-center justify-end text-right ${styles.calorie}`}>
    <span className="flex flex-col items-end">
      <strong className="kcal text-heading font-medium leading-none tabular-nums">{fmt(kcal)}</strong>
      <span className={`mt-1 text-tiny font-medium uppercase leading-none tracking-[0.12em] ${styles.kcalUnit}`}>kcal</span>
    </span>
  </span>;
}

/** The card's main action, in words: "Mark eaten" (olive) until the meal is ticked off, then "Eaten"
 *  (secondary), which undoes it. Each name starts with the words on the button (WCAG 2.5.3), so the
 *  name changes with the state and there is no aria-pressed to contradict it. The page's feedback
 *  phase shows on the button itself. */
/** Spoken summary of a meal's numbers, shared by the featured panel and the compact figures. */
export function macroLabel(macros: Macros): string {
  return `${fmt(macros.kcal)} calories: ${fmt(macros.protein)} grams protein, ${fmt(macros.carbs)} grams carbs, ${fmt(macros.fat)} grams fat`;
}

/** The eaten zone of the card's strip (meal cards v3): an icon, not a pill — an open ring until the
 *  meal is ticked off, then a filled tick, which undoes it. Each name starts with the state it acts
 *  on (WCAG 2.5.3), so there is no aria-pressed to contradict it. The page's feedback phase shows on
 *  the zone itself; pending, it is busy and takes no second tap. */
export function MealEatenButton({ eaten, label, feedback, onToggleEaten, className = "" }: {
  eaten: boolean;
  label: string;
  feedback?: ActionFeedbackPhase;
  onToggleEaten: () => void;
  className?: string;
}) {
  const eatenProps = feedbackStateProps(feedback);
  const busy = feedback === "pending";
  return <button type="button" onClick={onToggleEaten} disabled={busy} aria-busy={busy || undefined}
    data-feedback-state={eatenProps["data-feedback-state"]} data-eaten={eaten ? "true" : "false"}
    aria-label={eaten ? `Eaten, ${label}. Undo` : `Mark eaten, ${label}`} data-consume-control="tick"
    className={`${eatenProps.className} ${className}`}>
    <CheckIcon filled={eaten} />
  </button>;
}

/** The boundary between a meal's hero and its detail. Featured, the reference's olive spec panel:
 *  tracked labels over cream values, split by hairlines (meal cards v3: no proportional bar). Compact,
 *  it folds away and the hero carries calories and protein. */
export default function MealNutritionDivider({ macros, compact = false }: { macros: Macros; compact?: boolean }) {
  const reduceMotion = useReducedMotion();
  const items = macroItems(macros);
  const label = macroLabel(macros);
  // Opening, the panel grows open and its words fade up; closing, they fade
  // and it folds away on the same spring, so the card's height never jumps.
  const rise = reduceMotion ? {} : {
    initial: { opacity: 0, height: 0 }, animate: { opacity: 1, height: "auto" },
    exit: { opacity: 0, height: 0, transition: { ...SPRINGS.gentle, opacity: { ...FADES.quick, delay: 0.16 } } },
    transition: { ...SPRINGS.gentle, opacity: { duration: 0.22, delay: 0.04 } },
  };
  return <div data-after-dark-nutrition="true" role={compact ? undefined : "img"} aria-label={compact ? undefined : label}
    className={styles.divider}>
    <AnimatePresence initial={false}>
      {!compact && <motion.div key="panel" className="w-full overflow-clip" {...rise}>
        <div data-macro-legend="true" className={styles.panel}>
          <div className={`grid grid-cols-3 ${styles.specs}`}>
            {items.map((item) => <span key={item.short} className={styles.spec}>
              <span className={`eyebrow ${styles.specLabel}`}>
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full bg-current ${item.role}`} />
                {item.name}
              </span>
              <strong className={`tabular-nums ${styles.specValue}`}>{fmt(item.value)}g</strong>
            </span>)}
          </div>
        </div>
      </motion.div>}
    </AnimatePresence>
  </div>;
}
