"use client";

import { useEffect, useMemo, useRef } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import ExplainerPlayer, { ExplainerStage, type Explainer } from "@/components/today/ExplainerPlayer";
import TipTile from "@/components/today/TipTile";
import AutoHeight from "@/components/ui/AutoHeight";
import Button from "@/components/ui/Button";
import type { useActionFeedback } from "@/components/ui/ActionFeedback";
import TipStage from "@/components/today/tips/TipStage";
import WaterTile from "@/components/today/WaterTile";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import { eatenBound, withBound } from "@/lib/nutrition-display";
import { orderTips, weekSummary, type BoardTip, type NextMeal, type TipContext, type WeekSummary } from "@/lib/today/board";
import type { DayType, Store } from "@/lib/types";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { OrbitWater } from "@/lib/today/health-orbit";
import styles from "@/components/today/DayBoard.module.css";

export type BoardData = {
  next: NextMeal | null;
  /** Planned meals on the viewed day, so "nothing next" can say whether they are all eaten. */
  planned: number;
  onMarkEaten?: (slot: NextMeal["slot"]) => void;
  /** The page's feedback props for that slot's eaten write: the check waits while any write is pending. */
  markEatenControl?: (slot: NextMeal["slot"]) => MarkEatenControl;
  /** This week, already summarised; or Today's plan inputs to summarise it from (read once per
   *  store): the same store and verified foods Today resolves its own day with. */
  week?: WeekSummary;
  store?: Store;
  eligibleIds?: ReadonlySet<string>;
  onSelectDate?: (date: string) => void;
  /** The water tile's scrub and keyboard amount: the day's new total in cups, written once. */
  onSetWater?: (cups: number) => void;
  tips: BoardTip[];
  explainers: Explainer[];
};

type MarkEatenControl = ReturnType<ReturnType<typeof useActionFeedback>["controlPropsFor"]>;

/** A tap this soon after the next meal changed was meant for the check that just left. */
const SETTLE_MS = 400;

type Props = BoardData & {
  date: string;
  today: string;
  water?: OrbitWater;
  onAddCup?: () => void;
  /** The viewed day's type, for ordering tips (a training day leads with moving a meal's time). */
  dayType?: DayType;
  /** True while the board is the face on show: its tiles settle in each time it opens. */
  active: boolean;
  /** Seconds the tiles wait before settling in: the Day card holds them while the overview's
   *  entities gather, so the board arrives as the orbit leaves rather than under it. */
  enterDelay?: number;
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "13:30" → "1:30 PM". */
function clock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** Each tile settles a beat after the one before it whenever the board comes into view. */
function tile(index: number, active: boolean, reduce: boolean, delay = 0) {
  return {
    initial: false as const,
    animate: active ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.97 },
    transition: reduce ? INSTANT : active ? { ...SPRINGS.smooth, delay: delay + 0.03 + index * 0.04 } : FADES.quick,
  };
}

function CheckIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
}

/** While a tile animates away it is already gone for assistive tech, the keyboard and taps. */
function Leaving({ children, className, ...motionProps }: React.ComponentProps<typeof motion.div>) {
  const present = useIsPresent();
  return <motion.div className={className} inert={!present} aria-hidden={present ? undefined : true} {...motionProps}>
    {children}
  </motion.div>;
}

function NextTile({ next, planned, onMarkEaten, markEatenControl, date, today }:
  Pick<Props, "next" | "planned" | "onMarkEaten" | "markEatenControl" | "date" | "today">) {
  const reduce = useReducedMotionConfig() ?? false;
  // When the next meal last changed under the check: a second tap of a quick double tap lands on the
  // following meal's check in the same spot, so taps that soon are ignored (UI audit 2026-10-18).
  const changedAt = useRef<number | null>(null);
  const shownSlot = useRef(next?.slot ?? null);
  useEffect(() => {
    const slot = next?.slot ?? null;
    if (slot !== shownSlot.current) { shownSlot.current = slot; changedAt.current = performance.now(); }
  }, [next?.slot]);
  const markEaten = (slot: NextMeal["slot"]) => {
    if (changedAt.current !== null && performance.now() - changedAt.current < SETTLE_MS) return;
    onMarkEaten?.(slot);
  };
  const eyebrow = date === today ? "Next" : date < today ? "Still open" : "Coming up";
  const showMeal = (slot: string) => {
    const card = document.querySelector<HTMLElement>(`[data-slot-card="${slot}"]`);
    card?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  };
  return <div className={`matte matte-grain ${styles.next}`}>
    <AnimatePresence mode="popLayout" initial={false}>
      {next ? <Leaving key={next.slot} className={styles.nextBody}
        initial={reduce ? false : { opacity: 0, x: 24, filter: "blur(4px)" }}
        animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
        exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, x: -24, filter: "blur(4px)", transition: FADES.quick }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <button type="button" className={`tap ${styles.nextOpen}`} onClick={() => showMeal(next.slot)}
          aria-label={`${eyebrow}: ${next.name} at ${clock(next.time)}, ${fmt(next.kcal)} kcal. Show the meal`}>
          <span className={styles.thumb} aria-hidden="true">
            {next.image ? <Image src={next.image} alt="" fill sizes="64px" className={styles.thumbPhoto} />
              : <span className={styles.thumbBlank} />}
          </span>
          <span className="flex min-w-0 flex-col gap-1 text-left">
            <span className={styles.eyebrow}>{eyebrow} · {clock(next.time)}</span>
            <span className={styles.nextName}>{next.name}</span>
            <span className={styles.nextMeta}>
              <MacroLine label="word" only={["kcal", "protein"]}
                values={{ kcal: next.kcal, protein: next.protein, carbs: null, fat: null }} />
            </span>
          </span>
        </button>
        {/* The system's primary circle (DESIGN.md §Buttons); it presses like every button. */}
        {onMarkEaten && <Button variant="primary" shape="circle" {...markEatenControl?.(next.slot)}
          className={[styles.eat, markEatenControl?.(next.slot).className].filter(Boolean).join(" ")}
          aria-label={`Mark ${next.name} eaten`} onClick={() => markEaten(next.slot)}>
          <CheckIcon />
        </Button>}
      </Leaving> : <motion.div key="none" className={`${styles.nextBody} ${styles.nextDone}`}
        initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <span className={styles.doneMark} aria-hidden="true"><CheckIcon /></span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className={styles.eyebrow}>{planned > 0 ? "All logged" : "Nothing planned"}</span>
          <span className={styles.nextMeta}>{planned > 0 ? "Every planned meal on this day is eaten." : "No meals are planned for this day."}</span>
        </span>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

function WeekTile({ week, onSelectDate, active, delay = 0 }: Pick<Props, "onSelectDate" | "active"> & {
  week: WeekSummary; delay?: number;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const scale = Math.max(1, ...week.days.map((day) => (day.target ? day.kcal / day.target : 0)));
  const summary = week.elapsed > 0 ? `${week.onPlan} of ${week.elapsed} ${week.elapsed === 1 ? "day" : "days"} on plan` : "Starts Monday";
  return <div className={styles.week}>
    <span className="flex items-baseline justify-between gap-2">
      <span className={styles.eyebrow}>This week</span>
      <span className={styles.weekSummary}>{summary}</span>
    </span>
    <div className={styles.bars} role="group" aria-label="Calories by day this week">
      {week.days.map((day, index) => {
        const share = day.target ? Math.min(day.kcal / day.target, scale) / scale : 0;
        const label = `${day.date}: ${day.kcal > 0 ? withBound(`${fmt(day.kcal)} kcal`, eatenBound(day.partial === true)) : "nothing logged"}${day.target ? ` of ${fmt(day.target)}` : ""}, ${day.status}`;
        return <button key={day.date} type="button" className={styles.barCell} aria-label={label}
          aria-current={day.isViewed ? "date" : undefined} disabled={!onSelectDate}
          onClick={() => onSelectDate?.(day.date)}>
          <span className={styles.barTrack} aria-hidden="true">
            {/* A full track is the day's target. Once a day goes past it the tracks rescale and the
                target is drawn dashed across the week at the same height in every track. */}
            {day.target && scale > 1 ? <span className={styles.targetLine} style={{ bottom: `${(1 / scale) * 100}%` }} /> : null}
            <motion.span className={styles.bar} data-viewed={day.isViewed || undefined} data-empty={day.kcal === 0 || undefined}
              initial={false} animate={{ height: `${Math.round((active ? Math.max(day.kcal > 0 ? 0.08 : 0, share) : 0) * 100)}%` }}
              transition={reduce ? INSTANT : { ...SPRINGS.bouncy, delay: active ? delay + 0.15 + index * 0.04 : 0 }} />
          </span>
          <span className={styles.barLetter} data-viewed={day.isViewed || undefined} data-today={day.isToday || undefined}
            aria-hidden="true">{day.letter}</span>
        </button>;
      })}
    </div>
    {week.averageKcal !== null && <span className={styles.weekMeta}>Average <MacroFigure macro="kcal"
      value={week.averageKcal} bound={eatenBound(week.averagePartial === true)} /> on logged days</span>}
  </div>;
}

/** What the board knows about the viewed day, for putting the tips that matter now first. */
function tipContext(props: Props): TipContext {
  return {
    date: props.date,
    today: props.today,
    water: props.water ? { cups: props.water.cups, goal: props.water.goal } : null,
    planned: props.planned,
    open: props.next !== null,
    firstOpenedAt: props.store?.firstOpenedAt ?? null,
    training: props.dayType !== undefined && props.dayType !== "rest",
  };
}

/**
 * The Day card's board (2026-10-01): a bento of pins, everything in view at once (Jev, 82 %). The
 * next meal leads with its one action; water and the tip share one row and are always the same
 * height, whichever needs more setting it (`.pairCell`); this week's bars select a day.
 * Explainers grow into a player that fills the board (ExplainerStage), and the tip grows into its
 * full view the same way (TipStage); both keep every tile mounted under them. The tips come
 * ordered by what matters on the viewed day (lib/today/board.ts `orderTips`), from data the board
 * already has.
 */
export default function DayBoard(props: Props) {
  const { active, explainers, date, today, enterDelay = 0 } = props;
  const week = useMemo(() => props.week ?? (props.store ? weekSummary(props.store, date, today, props.eligibleIds) : null),
    [props.week, props.store, props.eligibleIds, date, today]);
  // A handful of tips and pure predicates: cheap enough to order on every render.
  const tips = orderTips(props.tips, tipContext(props));
  const reduce = useReducedMotionConfig() ?? false;
  const settle = (index: number) => tile(index, active, reduce, enterDelay);
  // One box follows the board's height for both stages: nested, the outer box chased the inner one
  // on a spring of its own and settled after the frame had landed (the "gum" on close).
  return <AutoHeight spring="gentle"><TipStage tips={tips} active={active}>
    {(openTip, shownTipId) => <ExplainerStage explainers={explainers} active={active}>
      {(play) => <>
        <motion.div className={styles.span2} {...settle(0)}>
          <NextTile next={props.next} planned={props.planned} onMarkEaten={props.onMarkEaten}
            markEatenControl={props.markEatenControl} date={props.date} today={props.today} />
        </motion.div>
        {/* With no tips (the Overview face) the water tile takes the whole row, no empty half. */}
        <motion.div className={tips.length > 0 ? styles.pairCell : `${styles.pairCell} ${styles.span2}`}
          data-pair="water" {...settle(1)}>
          <WaterTile water={props.water} onAddCup={props.onAddCup} onSetCups={props.onSetWater} active={active} />
        </motion.div>
        {tips.length > 0 && <motion.div className={styles.pairCell} data-pair="tip" {...settle(2)}>
          <TipTile tips={tips} shownId={shownTipId} onOpen={openTip} />
        </motion.div>}
        {week && <motion.div className={styles.span2} {...settle(3)}>
          <WeekTile week={week} onSelectDate={props.onSelectDate} active={active} delay={enterDelay} />
        </motion.div>}
        {explainers.map((item, index) => <motion.div key={item.id} className={styles.span2} {...settle(4 + index)}>
          <ExplainerPlayer.Pin explainer={item} onPlay={(from) => play(item.id, from)} />
        </motion.div>)}
      </>}
    </ExplainerStage>}
  </TipStage></AutoHeight>;
}
