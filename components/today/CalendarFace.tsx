"use client";

import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/Button";
import { balance } from "@/components/today/LiveWidgetPanels";
import { formatMacro } from "@/components/nutrition/spec";
import { balanceBound, withBound } from "@/lib/nutrition-display";
import type { OverviewData } from "@/components/today/overview/types";
import styles from "@/components/today/DayCard.module.css";

/**
 * The Day card's Calendar face (UI makeover §2.1, §5): the week strip over one line about the viewed
 * day, "1,240 kcal left · Next 12:30". The companion lives in Overview only. Without a target
 * revision, the strip over a "Finish your profile" prompt (nothing invented).
 */
/** No target revision for the viewed day: one way to get one, and nothing invented. */
export function ProfilePrompt() {
  return <div className={styles.profile}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="m-0 text-[16px] font-medium text-charcoal">Finish your profile</h3>
        <p className="m-0 text-caption text-muted">Add your details to get daily targets.</p>
      </div>
      {/* A link, so it wears the primary recipe (Button renders only <button>); it says its verb. */}
      <a href="/settings" className={buttonClasses({ variant: "primary", className: "shrink-0" })}>Set up</a>
    </div>;
}

/** The viewed day's meals in a few words: the next one, or that every planned meal is eaten. */
function mealsPart({ next, planned, when }: Pick<OverviewData, "next" | "planned" | "when">): string | null {
  // A past day has no "next": its uneaten meals stay unsaid.
  if (next) return when === "past" ? null : `Next ${next.time}`;
  if (planned === 0 || when === "future") return null;
  return planned === 1 ? "Meal eaten" : `All ${planned} meals eaten`;
}

/** "1,240 kcal left" or "180 kcal over"; "at most" / "at least" while a serving is partly measured. */
export function kcalLine(data: Pick<OverviewData, "consumed" | "partial"> & { targets: NonNullable<OverviewData["targets"]> }): string {
  const { amount, over } = balance("kcal", data);
  return `${withBound(`${formatMacro(amount)} kcal`, balanceBound(data.partial, over))} ${over ? "over" : "left"}`;
}

export default function CalendarFace({ calendar, data }: {
  /** The week strip (components/TodayDayStrip.tsx), which also grows the month. */
  calendar: ReactNode;
  data: OverviewData;
  /** True while this face is on show (kept for the card's contract; nothing here runs a loop). */
  active?: boolean;
}) {
  const { targets, consumed, partial } = data;
  const meals = mealsPart(data);
  return <>
    {calendar}
    {targets ? <p className="m-0 border-t border-hairline px-5 pb-4 pt-3 text-body font-medium tabular-nums">
        <span className="text-charcoal">{kcalLine({ targets, consumed, partial })}</span>
        {meals && <span className="text-muted">{` · ${meals}`}</span>}
      </p> : <ProfilePrompt />}
  </>;
}
