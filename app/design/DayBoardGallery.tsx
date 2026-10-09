"use client";
/**
 * Every Day card board state on static sample data (app/design/day-board). No network, no device
 * store: each board is mounted with fixture props alone, inside the Day card's own ivory shell, so
 * the states can be reviewed and screenshotted at phone width without an account (board redesign
 * v4, brief §5).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LayoutGroup } from "motion/react";
import DayBoard from "@/components/today/DayBoard";
import { DAY_CARD_EXPLAINER } from "@/components/today/ExplainerPlayer";
import { boardTips, type BoardTip, type NextMeal, type WeekDay, type WeekSummary } from "@/lib/today/board";
import type { OrbitWater } from "@/lib/today/health-orbit";

const TODAY = "2026-10-08";

const LONG: NextMeal = {
  slot: "meal-3", label: "Meal 3", name: "Pork tenderloin with roasted sweet potato",
  time: "15:00", kcal: 593, protein: 53, image: "/meal-art/chicken.webp",
};
const SHORT: NextMeal = {
  slot: "meal-2", label: "Meal 2", name: "Scallops", time: "12:30", kcal: 410, protein: 38,
  image: "/meal-art/scallops.webp",
};
const NO_PHOTO: NextMeal = {
  slot: "meal-4", label: "Meal 4", name: "Lentil soup and rye", time: "18:30", kcal: 520, protein: 27, image: null,
};

/** Monday-first week of 2026-10-05; `logged` days carry calories, `viewed`/`today` are indexes. */
function week({ logged, viewed, today }: { logged: number[]; viewed: number; today: number | null }): WeekSummary {
  const kcal = [1820, 2140, 1500, 1960, 0, 0, 0];
  const days = Array.from({ length: 7 }, (_, i): WeekDay => ({
    date: `2026-10-${String(5 + i).padStart(2, "0")}`, letter: "MTWTFSS"[i],
    kcal: logged.includes(i) ? kcal[i] || 1700 : 0, target: 2000,
    status: logged.includes(i) ? "all done" : i < (today ?? 7) ? "missed" : "not due yet",
    isToday: i === today, isViewed: i === viewed,
  }));
  const past = days.filter((_, i) => today === null || i <= today);
  const counted = days.filter((day) => day.kcal > 0);
  return {
    days, onPlan: counted.length, elapsed: past.length,
    averageKcal: counted.length ? Math.round(counted.reduce((s, d) => s + d.kcal, 0) / counted.length) : null,
    averagePartial: false,
  };
}

const WEEK = week({ logged: [0, 1, 3], viewed: 3, today: 3 });
const COACH_TIPS: BoardTip[] = boardTips([{ id: "coach-protein", source: "coach",
  text: "Have your protein first at lunch; it keeps the afternoon steady." }]);

type Fixture = {
  title: string; note: string;
  next: NextMeal | null; planned?: number; date?: string; markEaten?: boolean; swap?: boolean;
  water?: OrbitWater; week?: WeekSummary; tips?: BoardTip[];
  /** A gallery-only step after mount: tap Mark eaten, or key a pending water amount. */
  act?: "eat" | "stage";
};

const FIXTURES: Fixture[] = [
  { title: "Next · long name", note: "Wraps to two lines; photo; 3-zone strip.", next: LONG, swap: true },
  { title: "Next · very long name", note: "Past two lines it clamps at the end of the second.",
    next: { ...LONG, name: "Pork tenderloin with roasted sweet potato, green beans and a mustard glaze" } },
  { title: "Next · short name", note: "One line; partial water.", next: SHORT, water: { cups: 3, goal: 16, unit: "oz" } },
  { title: "Next · no photo", note: "The olive produce art stands in.", next: NO_PHOTO },
  { title: "Next · eaten just now", note: "The zone's tick, before the next meal slides in.", next: SHORT, act: "eat" },
  { title: "Still open", note: "A past viewed day: the eyebrow says so.", next: NO_PHOTO, date: "2026-10-06",
    week: week({ logged: [0, 1, 3], viewed: 1, today: 3 }) },
  { title: "Coming up", note: "A future viewed day.", next: SHORT, date: "2026-10-10",
    week: week({ logged: [0, 1, 3], viewed: 5, today: 3 }) },
  { title: "All logged", note: "next === null with meals planned.", next: null, planned: 4, water: { cups: 16, goal: 16, unit: "oz" } },
  { title: "Nothing planned", note: "next === null, no meals.", next: null, planned: 0, water: { cups: 0, goal: 16, unit: "oz" } },
  { title: "No mark-eaten writer", note: "Two even zones: Swap and Open.", next: LONG, markEaten: false },
  { title: "Water · empty", note: "Zero of the goal.", next: SHORT, water: { cups: 0, goal: 16, unit: "oz" } },
  { title: "Water · full", note: "At the goal.", next: SHORT, water: { cups: 16, goal: 16, unit: "oz" } },
  { title: "Water · staged", note: "A keyed amount waits as a signed delta.", next: SHORT, act: "stage" },
  { title: "Week · empty days", note: "Nothing logged yet: 3 px slivers, today marked.", next: SHORT,
    week: week({ logged: [], viewed: 0, today: 0 }) },
  { title: "Week · viewed ≠ today", note: "Viewed bar olive; today's letter red.", next: SHORT,
    week: week({ logged: [0, 1, 3], viewed: 1, today: 3 }) },
  { title: "Tip from the coach", note: "The coach's tip leads the row.", next: SHORT, tips: COACH_TIPS },
];

function Block({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <section aria-label={title} data-gallery-board={title} className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5 px-1">
      <h2 className="m-0 text-heading-sm font-semibold text-charcoal">{title}</h2>
      <p className="m-0 text-tiny text-muted">{note}</p>
    </div>
    {children}
  </section>;
}

function GalleryBoard({ fixture }: { fixture: Fixture }) {
  const [water, setWater] = useState<OrbitWater>(fixture.water ?? { cups: 6, goal: 16, unit: "oz" });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = root.current;
    if (!scope) return;
    if (fixture.act === "eat") scope.querySelector<HTMLButtonElement>('button[aria-label^="Mark "]')?.click();
    if (fixture.act === "stage") {
      const tile = scope.querySelector<HTMLButtonElement>('button[aria-label*="of water"]');
      tile?.focus({ preventScroll: true });
      for (let i = 0; i < 2; i++) tile?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
  }, [fixture.act]);
  const noop = () => {};
  // Each board namespaces its shared-layout ids: the app mounts one board, the gallery many, and
  // Motion would otherwise hide every duplicate tip and explainer row after the first.
  return <LayoutGroup id={fixture.title}><div ref={root} className="shell">
    <div className="surface overflow-hidden rounded-[32px]">
      <DayBoard date={fixture.date ?? TODAY} today={TODAY} active water={water}
        onAddCup={() => setWater((w) => ({ ...w, cups: w.cups + 1 }))}
        onSetWater={(cups) => setWater((w) => ({ ...w, cups }))}
        next={fixture.next} planned={fixture.planned ?? 4}
        onMarkEaten={fixture.markEaten === false ? undefined : noop}
        onSwapNext={fixture.swap ? noop : undefined}
        onSelectDate={noop} week={fixture.week ?? WEEK}
        tips={fixture.tips ?? boardTips()} explainers={[DAY_CARD_EXPLAINER]} />
    </div>
  </div></LayoutGroup>;
}

export default function DayBoardGallery() {
  return <main className="harvest-ground mx-auto flex min-h-dvh w-full max-w-md flex-col gap-8 px-4 py-6">
    <h1 className="m-0 font-display text-heading text-charcoal">Day board</h1>
    {FIXTURES.map((fixture) => <Block key={fixture.title} title={fixture.title} note={fixture.note}>
      <GalleryBoard fixture={fixture} />
    </Block>)}
  </main>;
}
