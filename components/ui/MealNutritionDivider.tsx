"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FADES, SPRINGS } from "@/lib/design/motion";
import type { Macros } from "@/lib/types";
import Button from "./Button";
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

function CheckIcon({ filled }: { filled: boolean }) {
  const reduceMotion = useReducedMotion();
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"
      fill={filled ? "currentColor" : "none"} fillOpacity={filled ? 0.18 : 0} />
    {/* An open ring until the meal is eaten, so the button never reads as already ticked. */}
    {filled && <motion.path d="m8 12.4 2.8 2.8L16.2 9.6" stroke="currentColor" strokeWidth="2"
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
export function MealEatenButton({ eaten, label, feedback, onToggleEaten }: {
  eaten: boolean;
  label: string;
  feedback?: ActionFeedbackPhase;
  onToggleEaten: () => void;
}) {
  const eatenProps = feedbackStateProps(feedback);
  return <Button size="sm" variant={eaten ? "secondary" : "primary"} onClick={onToggleEaten}
    data-feedback-state={eatenProps["data-feedback-state"]} data-eaten={eaten ? "true" : "false"}
    aria-label={eaten ? `Eaten, ${label}. Undo` : `Mark eaten, ${label}`} data-consume-control="tick"
    confirmLabel={eaten ? "Eaten" : "Not eaten"} leading={<CheckIcon filled={eaten} />}
    className={`shrink-0 ${styles.eaten}`}>
    {eaten ? "Eaten" : "Mark eaten"}
  </Button>;
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

/** The boundary between a meal's hero and its detail. Featured, the reference's olive
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
