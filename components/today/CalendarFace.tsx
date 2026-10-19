"use client";

import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/Button";
import LiveWidget from "@/components/today/LiveWidget";
import type { OverviewData } from "@/components/today/overview/types";
import styles from "@/components/today/DayCard.module.css";

/**
 * The Day card's Calendar face (UI makeover §2.1). Interim (W0): the week strip over the live widget,
 * exactly as the card drew it before; without a target revision, the strip over a "Finish your
 * profile" prompt (nothing invented). W3 replaces the widget with one line,
 * "1,240 kcal left · 2 of 4 meals".
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

export default function CalendarFace({ calendar, data, active }: {
  /** The week strip (components/TodayDayStrip.tsx), which also grows the month. */
  calendar: ReactNode;
  data: OverviewData;
  /** True while this face is on show: the widget's frame loops rest behind the other face. */
  active: boolean;
}) {
  const { targets, consumed, partial, water, onAddCup, rebalance, onOpenSlot, when } = data;
  return <>
    {calendar}
    {targets ? <LiveWidget data={{ targets, consumed, partial, water, onAddCup, rebalance, onOpenSlot }}
      paused={!active} when={when} /> : <ProfilePrompt />}
  </>;
}
