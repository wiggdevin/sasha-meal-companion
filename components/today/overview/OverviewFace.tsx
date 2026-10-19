"use client";

import DayOverview from "@/components/today/DayOverview";
import { ProfilePrompt } from "@/components/today/CalendarFace";
import DayBoard from "@/components/today/DayBoard";
import { RebalanceFull } from "@/components/today/RebalancePanelFace";
import CompanionSlot from "@/components/today/overview/CompanionSlot";
import TrendsSlot from "@/components/today/overview/TrendsSlot";
import type { OverviewData } from "@/components/today/overview/types";

/**
 * The Day card's Overview face, the face it opens on (UI makeover §4). Interim (W0): the glass wells
 * when the viewed day has a target revision, the old Board without its tips and explainers, and the
 * read-only rebalance panel when the page passes one. W2 replaces the body with the summary, next
 * meal and rebalance rows; the companion (W3) and the week's charts (W4) fill their slots.
 */
export default function OverviewFace({ data, active }: {
  data: OverviewData;
  /** True while this face is on show: the board's tiles settle in each time it opens. */
  active: boolean;
}) {
  const { targets, consumed, partial, water, onAddCup, onSetCups, rebalance, onOpenSlot, body } = data;
  return <>
    {targets ? <DayOverview data={{ targets, consumed, partial, water, onAddCup, rebalance, onOpenSlot }} body={body} /> : <ProfilePrompt />}
    {rebalance?.show && <div className="px-4 pb-2">
      <RebalanceFull panel={rebalance} onOpenSlot={onOpenSlot} />
    </div>}
    <DayBoard next={data.next} planned={data.planned} onMarkEaten={data.onMarkEaten}
      markEatenControl={data.markEatenControl} week={data.week} store={data.store} eligibleIds={data.eligibleIds}
      onSelectDate={data.onSelectDate} onSetWater={onSetCups} tips={[]} explainers={[]}
      date={data.date} today={data.today} dayType={data.dayType} water={water} onAddCup={onAddCup}
      active={active} enterDelay={0} />
    <CompanionSlot data={data} active={active} />
    <TrendsSlot data={data} active={active} />
  </>;
}
