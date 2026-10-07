"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import TodayMonthCalendar from "@/components/TodayMonthCalendar";
import { useStripStatuses } from "@/components/today/use-strip-statuses";
import { selectionHaptic } from "@/lib/haptics";
import { MONTHS, shiftCalendarDay, WEEKDAYS, weekdayIndex, type DayCompletionStatus } from "@/lib/today/calendar";
import type { TodayLive } from "@/lib/today/resolve-inputs";
import { SPRINGS } from "@/lib/design/motion";
import type { Store } from "@/lib/types";

// The calendar arithmetic moved to lib/today/calendar.ts (2026-10-01) so the board can share it.
export { completionFor, mondayFor, shiftCalendarDay, weekCaption } from "@/lib/today/calendar";
// The per-day resolve (Sol R2 re-plan) moved to its own module so use-strip-statuses.ts can share
// it without importing the component it backs; re-exported so existing callers keep this path.
export { resolveStripDay } from "@/lib/today/resolve-strip-day";

function dotColor(status: DayCompletionStatus, selected: boolean) {
  switch (status) {
    case "all done": return selected ? "var(--color-gauge-carbs-end)" : "var(--color-primary)";
    case "partially done": return "var(--color-gauge-fat)";
    case "missed": return "var(--color-alert)";
    default: return selected ? "color-mix(in srgb, var(--color-on-olive) 35%, transparent)" : "rgba(0,0,0,0.12)";
  }
}

/** A day beyond `today` is always "not due yet" (`completionFor`'s own first check) — never
 *  resolved. A day this render's status cache has not reached yet reads as unplanned: neutral,
 *  never a synchronous guess. */
function statusFor(day: string, today: string, statuses: ReadonlyMap<string, DayCompletionStatus>): DayCompletionStatus {
  return day > today ? "not due yet" : statuses.get(day) ?? "unplanned";
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T12:00:00`) - Date.parse(`${b}T12:00:00`)) / 86_400_000);
}

const EMPTY_DATES: readonly string[] = [];

function fullDateLabel(date: string) {
  const weekday = weekdayIndex(date);
  return `${WEEKDAYS[weekday]}, ${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(-2))}, ${date.slice(0, 4)}`;
}

/** While the month folds away it is already gone for assistive tech and the keyboard. */
function Leaving({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return <div inert={!present} aria-hidden={present ? undefined : true}>{children}</div>;
}

export type TodayDayStripProps = {
  date: string;
  today: string;
  store: Store;
  onSelect: (date: string) => void;
  /**
   * The same live overrides Today resolves its own day from (app/page.tsx): eligible Eats, the
   * dated accepted-recipe overlay and the live rule-review readiness (lib/today/resolve-inputs.ts).
   * The overlay is date-gated, so each strip day only picks it up when it is itself the accepted
   * date. Without `live` (an unwired caller, or a test) each day resolves as stored, matching the
   * strip's prior, unprojected resolve.
   */
  live?: TodayLive;
};

const WINDOW_RADIUS = 28;

/** A deliberate flick advances exactly a week; slow scrubbing stays day by day. */
export function weekFlickOffset(distance: number, elapsed: number): number {
  return Math.abs(distance) >= 48 && elapsed > 0 && elapsed <= 350 && Math.abs(distance) / elapsed >= 0.45
    ? (distance < 0 ? 7 : -7) : 0;
}

/**
 * The day under the strip's centre, from layout offsets only. Rendered sizes would be wrong while
 * the calendar face is scaled (its 0.98 hidden state behind the board, or its entrance): a 2%
 * smaller day width read 28 days in as 29, so every recentre stepped one more day, forever.
 */
export function dayAtCentre(element: HTMLElement): string | null {
  const centre = element.scrollLeft + element.clientWidth / 2;
  let best: { date: string; gap: number } | null = null;
  for (const day of element.querySelectorAll<HTMLElement>("[data-date]")) {
    const gap = Math.abs(day.offsetLeft + day.offsetWidth / 2 - centre);
    if (!best || gap < best.gap) best = { date: day.dataset.date ?? "", gap };
  }
  return best?.date || null;
}

/** Instant scroll also cancels an in-flight smooth scroll when its anchor did not change. */
function centerDate(element: HTMLDivElement, date: string) {
  const center = element.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
  element.scrollTo({
    left: center ? center.offsetLeft - (element.clientWidth - center.offsetWidth) / 2 : element.scrollLeft,
    behavior: "instant",
  });
  return center;
}

export default function TodayDayStrip({ date, today, store, onSelect, live }: TodayDayStripProps) {
  const [anchor, setAnchor] = useState(date);
  const [navigationEpoch, setNavigationEpoch] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const selected = useRef(date);
  const touching = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gesture = useRef<{ x: number; y: number; at: number; date: string } | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastMonthPick = useRef(-Infinity);
  const focusMonthSelection = useRef(false);
  const suppressClick = useRef(false);
  const focusAfterMove = useRef(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const expandedStart = shiftCalendarDay(date, -3);
  const reduceMotion = useReducedMotion();
  const heading = useRef<HTMLButtonElement>(null);
  const calendarId = useId();
  const windowDates = useMemo(() => Array.from({ length: WINDOW_RADIUS * 2 + 1 }, (_, index) =>
    shiftCalendarDay(anchor, index - WINDOW_RADIUS)), [anchor]);
  // The month grid's own 28 days (components/TodayMonthCalendar.tsx: shiftCalendarDay(start, 7..34)),
  // prefetched only while it is open, so opening it never blocks on a synchronous resolve either.
  const monthDates = useMemo(() => monthOpen
    ? Array.from({ length: 28 }, (_, index) => shiftCalendarDay(expandedStart, index + 7)) : EMPTY_DATES,
    [monthOpen, expandedStart]);
  // Visible days first, then outward: closest to the strip's own centre is resolved first.
  const orderedDates = useMemo(() => {
    const unique = new Set([...windowDates, ...monthDates]);
    return [...unique].sort((a, b) => Math.abs(dayDiff(a, anchor)) - Math.abs(dayDiff(b, anchor)));
  }, [windowDates, monthDates, anchor]);
  const statuses = useStripStatuses(store, live, today, orderedDates);

  function emit(next: string) {
    if (next === selected.current) return;
    selected.current = next;
    selectionHaptic();
    onSelect(next);
  }

  // Only an external date jump recenters immediately. Day updates emitted while
  // scrubbing must never reset the scroll position underneath the user's finger.
  useLayoutEffect(() => {
    if (date !== selected.current) {
      selected.current = date;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      gesture.current = null;
      suppressClick.current = false;
      // Chromium can deliver compositor scroll frames after an instant reset.
      // Replace only the scrolling surface on EXTERNAL navigation: this cancels
      // its native animation/pan and leaves no old frames able to select a day.
      touching.current = false;
      setNavigationEpoch((epoch) => epoch + 1);
      setAnchor(date);
    }
  }, [date]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    function align() {
      if (!element || touching.current) return;
      const center = centerDate(element, selected.current);
      if (focusAfterMove.current) {
        center?.focus({ preventScroll: true });
        focusAfterMove.current = false;
      }
    }
    align();
    const observer = new ResizeObserver(align);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, navigationEpoch]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  function centeredDate() {
    const element = viewport.current;
    return element ? dayAtCentre(element) ?? selected.current : selected.current;
  }

  function settle() {
    if (touching.current) return;
    const next = centeredDate();
    emit(next);
    // Recycle only after native snapping/inertia finishes. Another four weeks
    // on either side are now available, without an ever-growing DOM.
    setAnchor(next);
  }

  function scrollToDay(next: string, focus = false) {
    const element = viewport.current;
    const target = element?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`);
    if (!element || !target) {
      focusAfterMove.current = focus;
      emit(next);
      setAnchor(next);
      return;
    }
    if (focus) target.focus({ preventScroll: true });
    element.scrollTo({
      left: target.offsetLeft - (element.clientWidth - target.offsetWidth) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }

  function scheduleSettle() {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, 180);
  }

  function closeMonth() {
    setMonthOpen(false);
    heading.current?.focus({ preventScroll: true });
  }

  // Double-tap toggles the month. Chromium on Android fires dblclick after the touch double-tap
  // too, so a second toggle within 400 ms is the same gesture and is dropped.
  const lastToggle = useRef(-Infinity);
  function toggleMonth() {
    const at = Date.now();
    if (at - lastToggle.current < 400) return;
    lastToggle.current = at;
    if (monthOpen) closeMonth();
    else setMonthOpen(true);
  }

  /** A date picked in the month grid follows the same selection path as a scrub. */
  function pickFromMonth(next: string, at: number) {
    if (at - lastMonthPick.current < 350) return;
    lastMonthPick.current = at;
    focusMonthSelection.current = true;
    emit(next);
    setAnchor(next);
  }

  useEffect(() => {
    if (!focusMonthSelection.current || date !== anchor) return;
    focusMonthSelection.current = false;
    viewport.current?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus({ preventScroll: true });
  }, [date, anchor]);

  return (
    <section aria-label="Choose a day" className="relative min-w-0" onDoubleClick={toggleMonth}
      onTouchStartCapture={(event) => {
        const touch = event.touches[0];
        touchStart.current = event.touches.length === 1 && touch
          ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        const end = event.changedTouches[0];
        touchStart.current = null;
        if (!start || !end || Math.hypot(end.clientX - start.x, end.clientY - start.y) > 8) {
          lastTap.current = null;
          return;
        }
        const prior = lastTap.current;
        const at = Date.now();
        if (prior && at - prior.at <= 330 && Math.hypot(end.clientX - prior.x, end.clientY - prior.y) <= 24) {
          lastTap.current = null;
          toggleMonth();
        } else lastTap.current = { x: end.clientX, y: end.clientY, at };
      }}
      onTouchCancel={() => { touchStart.current = null; lastTap.current = null; }}>
      <output className="sr-only" aria-live="polite">Selected day: {date}</output>
      <p id="day-strip-help" className="sr-only">Slide to select a day. Swipe quickly to move one week. Use arrow keys for days, Page Up or Page Down for weeks. Double-tap, or activate the date heading, to expand or collapse the calendar.</p>
      {/* The date heading is the keyboard and screen-reader toggle for the month. It is hidden until
          it has keyboard focus: sighted touch users double-tap, and the lens already marks the day. */}
      <div className="sr-only has-[:focus-visible]:not-sr-only has-[:focus-visible]:flex has-[:focus-visible]:justify-center has-[:focus-visible]:px-4 has-[:focus-visible]:pt-3">
        <button ref={heading} type="button" aria-label={`${fullDateLabel(date)}. ${monthOpen ? "Collapse" : "Expand"} calendar`} aria-expanded={monthOpen}
          aria-controls={monthOpen ? calendarId : undefined}
          onClick={() => monthOpen ? closeMonth() : setMonthOpen(true)}
          className="tap min-h-11 rounded-full border border-hairline px-4 text-body-sm font-medium text-charcoal focus-visible:outline-2 focus-visible:outline-primary">
          {fullDateLabel(date)}
        </button>
      </div>
      <div className="relative">
      {/* The lens (2026-10-01, replaces the red compass tick): an olive capsule fixed at the strip's
          centre, like an iOS picker. The days slide under it and the centred day reads cream. */}
      <span aria-hidden="true" data-day-lens="" className="day-lens pointer-events-none absolute left-1/2 top-2 z-0 h-20 w-[max(40px,calc(100%/7-6px))] -translate-x-1/2" />
      <div key={navigationEpoch} ref={viewport} role="group" aria-label="Days" aria-describedby="day-strip-help"
        className="relative z-[1] flex snap-x snap-mandatory select-none overflow-x-auto overscroll-x-contain pt-2 pb-2 [scrollbar-width:none] [-webkit-touch-callout:none] [&::-webkit-scrollbar]:hidden"
        onContextMenu={(event) => event.preventDefault()}
        onTouchStart={(event) => {
          touching.current = true;
          suppressClick.current = false;
          const touch = event.touches[0];
          gesture.current = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, date: selected.current };
        }}
        onTouchMove={(event) => {
          if (gesture.current && Math.abs(event.touches[0].clientX - gesture.current.x) > 8) suppressClick.current = true;
        }}
        onTouchEnd={(event) => {
          touching.current = false;
          const start = gesture.current;
          gesture.current = null;
          const end = event.changedTouches[0];
          if (start && end && Math.abs(end.clientX - start.x) > Math.abs(end.clientY - start.y)) {
            const offset = weekFlickOffset(end.clientX - start.x, event.timeStamp - start.at);
            if (offset) scrollToDay(shiftCalendarDay(start.date, offset));
          }
          scheduleSettle();
        }}
        onTouchCancel={() => { touching.current = false; gesture.current = null; scheduleSettle(); }}
        onScroll={(event) => { if (event.currentTarget !== viewport.current) return; emit(centeredDate()); scheduleSettle(); }}
        onScrollEnd={(event) => { if (event.currentTarget !== viewport.current) return; if (settleTimer.current) clearTimeout(settleTimer.current); settle(); }}
      >
        <div aria-hidden="true" style={{ flex: "0 0 calc(50% - max(22px, 100% / 14))" }} />
        {windowDates.map((day) => {
          const active = day === date;
          const status = statusFor(day, today, statuses);
          const weekday = weekdayIndex(day);
          const isToday = day === today;
          return <button key={day} type="button" data-date={day}
            aria-label={`${WEEKDAYS[weekday]} ${Number(day.slice(-2))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}, ${status}`}
            aria-pressed={active} aria-current={day === today ? "date" : undefined} tabIndex={active ? 0 : -1}
            className="tap flex h-20 shrink-0 basis-[max(44px,100%/7)] snap-center flex-col items-center justify-center gap-1.5"
            onClick={() => { if (!suppressClick.current) scrollToDay(day); suppressClick.current = false; }}
            onKeyDown={(event) => {
              const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday, PageUp: -7, PageDown: 7 }[event.key];
              if (offset !== undefined) { event.preventDefault(); scrollToDay(shiftCalendarDay(day, offset), true); }
            }}>
            {/* Ink on the ivory card; cream inside the olive lens. Today, outside the lens, is red. */}
            <span className={`text-[12px] font-medium transition-colors duration-150 ${active ? "text-on-primary" : "text-graphite"}`}>{WEEKDAYS[weekday].slice(0, 3)}</span>
            <span className={`text-[16px] tabular-nums leading-none transition-colors duration-150 ${
              active ? "font-semibold text-on-primary" : isToday ? "font-semibold text-alert" : "font-normal text-charcoal"}`}>{Number(day.slice(-2))}</span>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full transition-colors duration-150" style={{ background: dotColor(status, active) }} />
          </button>;
        })}
        <div aria-hidden="true" style={{ flex: "0 0 calc(50% - max(22px, 100% / 14))" }} />
      </div>
      </div>
      {/* The month grows out of the week on the card's own spring and folds back the same way. */}
      <AnimatePresence initial={false}>
        {monthOpen && <motion.div key="month" id={calendarId} className="overflow-hidden"
          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { ...SPRINGS.smooth, opacity: { duration: 0.2 } }}>
          <Leaving>
            <TodayMonthCalendar date={date} start={expandedStart} today={today}
              onSelect={pickFromMonth} onClose={closeMonth}
              dayStatus={(day) => {
                const status = statusFor(day, today, statuses);
                return { label: status, dot: dotColor(status, false) };
              }}
              reducedMotion={reduceMotion ?? false} />
          </Leaving>
        </motion.div>}
      </AnimatePresence>
    </section>
  );
}
