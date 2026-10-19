"use client";

import { useReducedMotionConfig } from "motion/react";
import CardFrame from "@/components/ui/CardFrame";
import { buttonClasses } from "@/components/ui/Button";
import { GRAM_MACROS, MACRO_SPEC, formatMacro } from "@/components/nutrition/spec";
import { balance, share } from "@/components/today/LiveWidgetPanels";
import { balanceBound, boundWords, eatenBound, withBound } from "@/lib/nutrition-display";
import type { Macros } from "@/lib/types";
import styles from "@/components/today/overview/OverviewFace.module.css";

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** The day's numbers in words, the summary's one accessible name. */
export function summarySpoken(targets: Macros, consumed: Macros, partial: boolean): string {
  const kcal = balance("kcal", { targets, consumed });
  const left = `${withBound(`${formatMacro(kcal.amount)} kcal`, balanceBound(partial, kcal.over))} ${kcal.over ? "over" : "left"}`;
  const eaten = `${withBound(formatMacro(consumed.kcal), eatenBound(partial))} of ${formatMacro(targets.kcal)} kcal eaten`;
  const macros = GRAM_MACROS.map((key) => `${MACRO_SPEC[key].label} ${withBound(formatMacro(consumed[key]), eatenBound(partial))} of ${formatMacro(targets[key])} grams`);
  return `${left}. ${eaten}. ${macros.join(", ")}. Show nutrients`;
}

/** No target revision for the viewed day: one way to get one, and nothing invented. */
function ProfileRow() {
  return <CardFrame size="sm" as="section" aria-label="Daily targets" title="Finish your profile"
    meta="Add your details to see daily targets."
    aside={<a href="/settings" className={buttonClasses({ variant: "primary" })}>Set up</a>} />;
}

/**
 * The cockpit's lead block (UI makeover §4 item 1, §11): calories left as the big numeral, the eaten
 * share as an 8 px bar, and protein, carbs and fat as three mini bars ("62/140 g"), all against the
 * revision in force on the viewed day. A partly measured day says "at most" left and "at least"
 * eaten, in words. A tap scrolls to the day's nutrients. Before the account's first revision it is the
 * "Finish your profile" prompt: no target, no bar, nothing invented.
 */
export default function SummaryRow({ targets, consumed, partial }: {
  targets: Macros | null;
  consumed: Macros;
  partial: boolean;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  if (!targets) return <ProfileRow />;
  const kcal = balance("kcal", { targets, consumed });
  const leftWords = boundWords(balanceBound(partial, kcal.over));
  const eatenWords = boundWords(eatenBound(partial));
  const toNutrients = () => document.getElementById("day-nutrients")
    ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  return <CardFrame size="sm" as="section" onClick={toNutrients}
    aria-label={summarySpoken(targets, consumed, partial)}>
    <div className={styles.summary} aria-hidden="true" data-over={kcal.over || undefined}>
      <div className={styles.lead}>
        <span className={`${styles.numeral} font-display`}>{formatMacro(kcal.amount)}</span>
        <span className={styles.leadText}>
          <span className={styles.leadWord}>{leftWords && `${leftWords} `}kcal {kcal.over ? "over" : "left"}</span>
          <span className={styles.leadMeta}>
            {eatenWords && `${eatenWords} `}{formatMacro(consumed.kcal)} of {formatMacro(targets.kcal)} eaten
          </span>
        </span>
      </div>
      <span className={styles.kcalTrack}>
        <span className={styles.kcalFill} style={{ width: pct(share(consumed.kcal, targets.kcal)) }} />
      </span>
      <ul className={styles.macros}>
        {GRAM_MACROS.map((key) => <li key={key} className={styles.macro} data-macro={key}>
          <span className={styles.macroHead}>
            <span className={styles.macroLabel}>{MACRO_SPEC[key].letter}</span>
            <span className={styles.macroValue}>
              <span className={`${MACRO_SPEC[key].ink} ${styles.macroNow}`}>{formatMacro(consumed[key])}</span>
              /{formatMacro(targets[key])} g
            </span>
          </span>
          <span className={styles.macroTrack}>
            <span className={styles.macroFill} style={{ width: pct(share(consumed[key], targets[key])) }} />
          </span>
        </li>)}
      </ul>
    </div>
  </CardFrame>;
}
