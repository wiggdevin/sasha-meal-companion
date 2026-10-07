"use client";
/**
 * The burn estimate in every engine phase, and the "day fully logged" control, on one page (UI pass
 * 2026-10-04, X1/X2). Static fixtures only: no network, no device store, no account's numbers.
 * Development only (app/design/tdee/page.tsx).
 */
import { useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import TdeeLines from "@/components/TdeeLines";
import WeightTrend from "@/components/WeightTrend";
import DayCompleteControl from "@/components/today/DayCompleteControl";
import { PROFILE_UNAVAILABLE } from "@/lib/tdee";
import { TDEE_FIXTURES } from "@/app/design/tdee-fixtures";
import type { StoredDay } from "@/lib/types";

const TODAY = "2026-10-04";
const LOGGED: StoredDay = { date: TODAY, eaten: { "meal-1": "2026-10-04T08:10:00.000Z" } };

/** The control over an in-memory day: a write takes a moment, and `fails` makes every write fail. */
function DayCompleteDemo({ date, initial, fails = false }: { date: string; initial: StoredDay;
  fails?: boolean }) {
  const [day, setDay] = useState<StoredDay>(initial);
  const save = (_date: string, complete: boolean) => new Promise<StoredDay>((resolve, reject) => {
    setTimeout(() => {
      if (fails) { reject(new Error("offline")); return; }
      const next: StoredDay = { ...day, dayCompleteAt: complete ? new Date().toISOString() : undefined };
      setDay(next);
      resolve(next);
    }, 600);
  });
  return <DayCompleteControl date={date} today={TODAY} readDay={() => day} save={save} />;
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="m-0 text-heading-sm font-semibold text-charcoal">{title}</h2>
      {note && <p className="m-0 text-tiny text-muted">{note}</p>}
    </div>
    {children}
  </section>;
}

/** The same shell `BodyDashboard`'s TDEE panel draws, so a fixture reads as it would on /body. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="shell"><div className="surface flex flex-col gap-3 p-4">
    <h3 className="m-0 text-title text-section">What you burn</h3>
    {children}
  </div></div>;
}

export default function TdeeGallery() {
  return <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 pb-40 pt-6">
    <h1 className="m-0 px-1 font-display text-heading text-charcoal">Day fully logged</h1>
    <Block title="Today, not marked" note="a meal ticked; tap to mark, tap again to clear">
      <DayCompleteDemo date={TODAY} initial={LOGGED} />
    </Block>
    <Block title="An earlier day, marked" note="the copy names that day, not today">
      <DayCompleteDemo date="2026-10-02"
        initial={{ ...LOGGED, date: "2026-10-02", dayCompleteAt: "2026-10-02T21:00:00.000Z" }} />
    </Block>
    <Block title="The write fails" note="the tick returns and a notice says so">
      <DayCompleteDemo date={TODAY} initial={LOGGED} fails />
    </Block>
    <Block title="Reduced motion" note="the fill and the notice arrive at once">
      <MotionConfig reducedMotion="always"><DayCompleteDemo date={TODAY} initial={LOGGED} /></MotionConfig>
    </Block>
    <Block title="Nothing logged, or a later day" note="no control at all">
      <DayCompleteDemo date={TODAY} initial={{ date: TODAY }} />
    </Block>
    <h1 className="m-0 px-1 font-display text-heading text-charcoal">Burn estimate</h1>
    {TDEE_FIXTURES.map(({ name, note, estimate }) => (
      <Block key={name} title={name} note={note}>
        <Panel><TdeeLines estimate={estimate} profile={PROFILE_UNAVAILABLE} days={[]} /></Panel>
        <WeightTrend status={estimate.status} weighInCount={estimate.weighInCount}
          phase={estimate.phase} trendKg={estimate.weightTrendSeriesKg ?? []} unit="kg" />
      </Block>
    ))}
  </main>;
}
