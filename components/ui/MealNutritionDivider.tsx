"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Macros } from "@/lib/types";
import { feedbackStateProps, type ActionFeedbackPhase } from "./ActionFeedback";
import styles from "./MealNutritionDivider.module.css";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

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
  // Pending, the zone stays focusable (aria-disabled, never disabled) and ignores the tap, so a
  // keyboard user keeps their place. The outcome is spoken once, by the page's named toast
  // ("Meal 2 marked eaten.", with Undo), never a second unnamed announcement here (Sol v3 review).
  return <button type="button" onClick={() => { if (!busy) onToggleEaten(); }} aria-disabled={busy || undefined}
    aria-busy={busy || undefined} data-feedback-state={eatenProps["data-feedback-state"]}
    data-eaten={eaten ? "true" : "false"} data-consume-control="tick"
    aria-label={eaten ? `Eaten, ${label}. Undo` : `Mark eaten, ${label}`}
    className={`${eatenProps.className} ${styles.eatenZone} ${className}`}>
    <CheckIcon filled={eaten} />
  </button>;
}
