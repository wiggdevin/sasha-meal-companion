"use client";

import SummaryRow from "@/components/today/overview/SummaryRow";
import NextMealRow from "@/components/today/overview/NextMealRow";
import RebalanceRow from "@/components/today/overview/RebalanceRow";
import CompanionSlot from "@/components/today/overview/CompanionSlot";
import TrendsSlot from "@/components/today/overview/TrendsSlot";
import type { OverviewData } from "@/components/today/overview/types";
import { nextStep } from "@/lib/today/board";
import styles from "@/components/today/overview/OverviewFace.module.css";

/**
 * What the cockpit reads beyond the Day card's contract (components/today/overview/types.ts, frozen):
 * the viewed day's eaten count, so the meals block can say "2 of 4 meals". Additive and optional;
 * Close-out may fold it into `OverviewData`.
 */
export type CockpitData = OverviewData & {
  /** Planned meals on the viewed day already eaten. Undefined when not known: no count is shown. */
  eaten?: number;
};

/** The most blocks the cockpit stacks, so the face fits a 390 × 844 phone above the dock with the
 *  companion and the week collapsed: summary, meals, rebalance, next step, companion, week. */
export const COCKPIT_MAX_BLOCKS = 6;

/**
 * The Day card's Overview face, the face it opens on: the daily cockpit (UI makeover §4, §11). One
 * screen, no scrolling: the summary (calories left, the macros), the meals (done of planned, the next
 * one and its time), the rebalance line when the page passes one, one next step, then the companion
 * row (W3) and the week's trends row (W4), each compact. Every block is a small CardFrame, which
 * inside the Day card takes the inset step, so no block blends into the card behind it. The cup is
 * the card header's (CupSlot): the face has no water control of its own.
 */
export default function OverviewFace({ data, active }: {
  data: CockpitData;
  /** True while this face is on show. */
  active: boolean;
}) {
  const { targets, consumed, partial, rebalance, onOpenSlot } = data;
  const step = nextStep({ when: data.when, planned: data.planned, next: data.next, water: data.water });
  return <div className={styles.face} data-cockpit="">
    <SummaryRow targets={targets} consumed={consumed} partial={partial} />
    <NextMealRow next={data.next} planned={data.planned} eaten={data.eaten} when={data.when}
      onMarkEaten={data.onMarkEaten} markEatenControl={data.markEatenControl} onOpenSlot={onOpenSlot} />
    {rebalance?.show && <RebalanceRow panel={rebalance} onOpenSlot={onOpenSlot} />}
    <p className={styles.step} data-next-step="">
      <span className={styles.stepMark} aria-hidden="true" />
      <span className={styles.stepText}>{step}</span>
    </p>
    <CompanionSlot data={data} active={active} />
    <TrendsSlot data={data} active={active} />
  </div>;
}
