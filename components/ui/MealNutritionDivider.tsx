"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FADES, SPRINGS } from "@/lib/design/motion";
import type { Macros } from "@/lib/types";
import { feedbackStateProps, type ActionFeedbackPhase } from "./ActionFeedback";
import styles from "./MealNutritionDivider.module.css";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function macroItems(macros: Macros) {
  const protein = Math.max(0, macros.protein * 4);
  const carbs = Math.max(0, macros.carbs * 4);
  const fat = Math.max(0, macros.fat * 9);
  const total = protein + carbs + fat;
  const shares = total > 0 ? [protein / total, carbs / total, fat / total] : [1, 1, 1];
  return [
    { short: "P", name: "Protein", value: macros.protein, role: "macro-protein", share: shares[0] },
    { short: "C", name: "Carbs", value: macros.carbs, role: "macro-carbs", share: shares[1] },
    { short: "F", name: "Fat", value: macros.fat, role: "macro-fat", share: shares[2] },
  ];
}

function CheckIcon() {
  const reduceMotion = useReducedMotion();
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <motion.path d="m5 12 5 5L20 7" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
      animate={{ pathLength: 1, opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.23, 1, 0.32, 1] }} />
  </svg>;
}

/** The meal's calorie total, set on the hero; tapping it marks the meal eaten. */
export function MealCalorieButton({ kcal, eaten, label, feedback, onToggleEaten }: {
  kcal: number;
  eaten: boolean;
  label: string;
  feedback?: ActionFeedbackPhase;
  onToggleEaten: () => void;
}) {
  const eatenProps = feedbackStateProps(feedback);
  return <motion.button type="button" onClick={onToggleEaten} {...eatenProps}
    disabled={feedback === "pending"} aria-pressed={eaten}
    aria-label={eaten ? `Mark ${label} not eaten` : `Mark ${label} eaten`}
    data-meal-calories="true" data-consume-control="calories"
    whileTap={{ scale: 0.92 }} transition={{ duration: 0.15 }}
    className={`relative z-10 tap flex min-h-11 shrink-0 items-center justify-end gap-1.5 text-right ${styles.calorie} ${eatenProps.className}`}>
    {eaten && <span className="text-charcoal"><CheckIcon /></span>}
    <span className="flex flex-col items-end">
      <strong className="kcal text-heading font-medium leading-none tabular-nums">{fmt(kcal)}</strong>
      <span className={`mt-1 text-tiny font-medium uppercase leading-none tracking-[0.12em] ${styles.kcalUnit}`}>kcal</span>
    </span>
  </motion.button>;
}

/** The proportional macro split as a hairline bar. One per card, keyed by `layoutId`, so it moves as
 *  one element between the compact hero (MealMacroBar) and the featured spec panel. */
function SplitBar({ macros, layoutId }: { macros: Macros; layoutId?: string }) {
  const reduceMotion = useReducedMotion();
  return <motion.div data-macro-composition="true" className={styles.bar} layoutId={reduceMotion ? undefined : layoutId}
    transition={SPRINGS.gentle}>
    {macroItems(macros).map((item) => <span key={item.short} aria-hidden="true"
      className={`bg-current ${item.role}`} style={{ flexGrow: item.share }} />)}
  </motion.div>;
}

/** The compact card's split bar, drawn inside the hero's text column so the photo beside it fills the
 *  card's whole left side down to the tray (2026-10-04, owner: the image "used to take up more space
 *  and fill the bottom section"). It fades in after the card has taken its compact shape. */
export function MealMacroBar({ macros, layoutId, className = "" }: {
  macros: Macros; layoutId?: string; className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const label = `${fmt(macros.kcal)} calories: ${fmt(macros.protein)} grams protein, ${fmt(macros.carbs)} grams carbs, ${fmt(macros.fat)} grams fat`;
  return <motion.div data-compact-bar="" role="img" aria-label={label} className={className}
    initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}
    exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: FADES.quick }}
    transition={reduceMotion ? { duration: 0 } : { duration: 0.2, delay: 0.2 }}>
    <SplitBar macros={macros} layoutId={layoutId} />
  </motion.div>;
}

/** The boundary between a meal's hero and its detail. Featured, the reference's ornament and olive
 *  spec panel: tracked labels over cream values, split by hairlines, with the proportional split
 *  along its foot. Compact, it folds away: the split bar lives in the hero then (MealMacroBar). */
export default function MealNutritionDivider({ macros, compact = false, layoutId }: {
  macros: Macros; compact?: boolean;
  /** One per card: the split bar keeps it as it moves from the compact hero into the panel. */
  layoutId?: string;
}) {
  const reduceMotion = useReducedMotion();
  const items = macroItems(macros);
  const label = `${fmt(macros.kcal)} calories: ${fmt(macros.protein)} grams protein, ${fmt(macros.carbs)} grams carbs, ${fmt(macros.fat)} grams fat`;
  const bar = <SplitBar macros={macros} layoutId={layoutId} />;
  // Opening, the panel grows open around the split bar and its words fade up; closing, they fade
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
        <div className={styles.ornament} aria-hidden="true"><span /><i /><span /></div>
        {/* Collapsed cards show only the split bar; the gram counts appear once the card expands. */}
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
          {bar}
        </div>
      </motion.div>}
    </AnimatePresence>
  </div>;
}
