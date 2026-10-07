"use client";

import { AnimatePresence, motion, useIsPresent, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import { FADES, INSTANT, SPRINGS, SWAP } from "@/lib/design/motion";
import { nextTrapFocus } from "@/lib/dom/sheet-a11y";
import { MONTHS, WEEKDAYS, shiftCalendarDay, weekdayIndex } from "@/lib/today/calendar";

/* ---- Calendar arithmetic on ISO "YYYY-MM-DD" strings (local calendar days, never instants) ---- */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day in ISO form, or null ("2026-02-30", "" and "soon" are not days). */
export function validIsoDay(value: string | null | undefined): string | null {
  const match = ISO_DAY.exec(value ?? "");
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? value as string : null;
}

/** Today on this device's calendar. */
export function localIsoToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "3 Sep 2026": the field's face. */
export function formatFieldDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${iso.slice(0, 4)}`;
}

/** "Thursday 3 September 2026": what a day cell and the sheet's subtitle say. */
export function longDate(iso: string): string {
  return `${WEEKDAYS[weekdayIndex(iso)]} ${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

function monthTitle(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "2026-09" moved by whole months. */
export function shiftMonth(month: string, offset: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string): number {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 12).getDate();
}

/** The same day of another month, held to that month's last day (31 Jan + 1 month = 28 Feb). */
function shiftDayByMonths(iso: string, offset: number): string {
  const month = shiftMonth(iso.slice(0, 7), offset);
  return `${month}-${String(Math.min(Number(iso.slice(8, 10)), daysInMonth(month))).padStart(2, "0")}`;
}

function clampMonth(month: string, min: string | null, max: string | null): string {
  if (min && month < min.slice(0, 7)) return min.slice(0, 7);
  if (max && month > max.slice(0, 7)) return max.slice(0, 7);
  return month;
}

function clampDay(iso: string, min: string | null, max: string | null): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/** Six Monday-first weeks: the month's days in place, null in the cells around them. A fixed six
 *  rows keeps the sheet one height from month to month. */
export function monthCells(month: string): (string | null)[] {
  const lead = weekdayIndex(`${month}-01`);
  const count = daysInMonth(month);
  return Array.from({ length: 42 }, (_, cell) => {
    const day = cell - lead + 1;
    return day >= 1 && day <= count ? `${month}-${String(day).padStart(2, "0")}` : null;
  });
}

const INITIALS = ["M", "T", "W", "T", "F", "S", "S"];
const KEY_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function Chevron({ direction }: { direction: "left" | "right" | "down" }) {
  const path = direction === "left" ? "m15 18-6-6 6-6" : direction === "right" ? "m9 18 6-6-6-6" : "m6 9 6 6 6-6";
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

export type DatePickerSheetProps = {
  /** The field's label: the sheet's title. */
  title: string;
  value: string | null;
  min?: string | null;
  max?: string | null;
  allowClear?: boolean;
  /** Today's ISO day; the device's own by default (tests pin it). */
  today?: string;
  /** Done hands over the chosen day, Clear hands over null. Closing any other way changes nothing. */
  onCommit(value: string | null): void;
  onClose(): void;
};

/**
 * The app's date picker (2026-10-01): the Today month grid made into a sheet. One month at a time
 * under a Playfair month name with previous and next arrows; the weekday initials once; the chosen
 * day wears the Day card's olive lens, which glides between taps; today's number is red. Tapping a
 * day only moves the lens, so a wrong tap costs nothing; Done commits (the meal-time sheet's
 * pattern). The month name opens a month grid for jumping back in time; the arrows then step years.
 * Close, the scrim, Escape and a pull down all leave the field as it was.
 */
export default function DatePickerSheet({ title, value, min = null, max = null, allowClear = false,
  today: todayProp, onCommit, onClose }: DatePickerSheetProps) {
  const present = useIsPresent();
  const reduce = useReducedMotion();
  const id = useId();
  const [today] = useState(() => todayProp ?? localIsoToday());
  const lower = validIsoDay(min);
  const upper = validIsoDay(max);
  const [draft, setDraft] = useState<string | null>(() => validIsoDay(value));
  const [focusDay, setFocusDay] = useState(() => clampDay(draft ?? today, lower, upper));
  const [month, setMonth] = useState(() => focusDay.slice(0, 7));
  const [direction, setDirection] = useState(0);
  const [view, setView] = useState<"days" | "months">("days");
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);

  const outOfRange = (day: string) => (lower !== null && day < lower) || (upper !== null && day > upper);
  const monthOutOfRange = (m: string) => (lower !== null && `${m}-${daysInMonth(m)}` < lower)
    || (upper !== null && `${m}-01` > upper);
  // The one day in the grid that Tab reaches: the focused day while it is in view, else the first
  // day of the month that can be chosen.
  const cells = monthCells(month);
  const tabDay = focusDay.slice(0, 7) === month && !outOfRange(focusDay) ? focusDay
    : cells.find((day): day is string => day !== null && !outOfRange(day)) ?? null;

  function showMonth(next: string) {
    if (next === month) return;
    setDirection(next > month ? 1 : -1);
    setMonth(next);
  }

  function moveFocus(next: string) {
    const day = clampDay(next, lower, upper);
    setFocusDay(day);
    showMonth(day.slice(0, 7));
    pendingFocus.current = true;
  }

  function choose(day: string) {
    setDraft(day);
    setFocusDay(day);
  }

  function commit(next: string | null) {
    onCommit(next);
    onClose();
  }

  // The Sheet focuses its first control after this effect; a frame later the day takes focus.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLButtonElement>('[data-date][tabindex="0"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    root.current?.querySelector<HTMLButtonElement>(`[data-month="${month}"] [data-date="${focusDay}"]`)?.focus();
  }, [focusDay, month]);

  function onGridKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset.date;
    if (!target) return;
    const step = KEY_STEP[event.key];
    let next: string | null = null;
    if (step !== undefined) next = shiftCalendarDay(target, step);
    else if (event.key === "PageUp") next = shiftDayByMonths(target, event.shiftKey ? -12 : -1);
    else if (event.key === "PageDown") next = shiftDayByMonths(target, event.shiftKey ? 12 : 1);
    else if (event.key === "Home") next = shiftCalendarDay(target, -weekdayIndex(target));
    else if (event.key === "End") next = shiftCalendarDay(target, 6 - weekdayIndex(target));
    if (next === null) return;
    event.preventDefault();
    moveFocus(next);
  }

  // This sheet may open over another sheet: it answers Escape and Tab itself and stops them, so the
  // sheet underneath neither closes nor pulls focus back into itself.
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" && event.key !== "Tab") return;
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const surface = root.current?.querySelector<HTMLElement>(".sheet-surface");
    const focusable = Array.from(surface?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((element) => !element.closest("[inert]"));
    const next = nextTrapFocus(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
    if (next) { event.preventDefault(); next.focus(); }
  }

  // Clear only when there is a saved date to clear.
  const clearable = allowClear && validIsoDay(value) !== null;
  const step = view === "days" ? 1 : 12;
  const previous = shiftMonth(month, -step);
  const following = shiftMonth(month, step);
  const canGoBack = view === "days" ? !monthOutOfRange(previous)
    : !monthOutOfRange(`${Number(month.slice(0, 4)) - 1}-12`);
  const canGoForward = view === "days" ? !monthOutOfRange(following)
    : !monthOutOfRange(`${Number(month.slice(0, 4)) + 1}-01`);
  const heading = view === "days" ? monthTitle(month) : month.slice(0, 4);
  const slide: Transition = reduce ? INSTANT : { x: SPRINGS.smooth, opacity: FADES.base, filter: FADES.base };
  const swap: Transition = reduce ? INSTANT : { ...SPRINGS.smooth, opacity: FADES.base, filter: FADES.base };

  return (
    <div ref={root} inert={!present} aria-hidden={present ? undefined : true} onKeyDown={onKeyDown}>
      <Sheet title={title} subtitle={draft ? longDate(draft) : "No date chosen"} onClose={onClose}
        footer={<div className="flex gap-2">
          {clearable && <Button variant="quiet" size="lg" className="flex-1" onClick={() => commit(null)}>Clear</Button>}
          <Button variant="primary" size="lg" className={clearable ? "flex-[2]" : "w-full"} disabled={draft === null}
            onClick={() => commit(draft)}>Done</Button>
        </div>}>
        <div className="flex min-w-0 flex-col gap-2 pb-1">
          <div className="flex min-w-0 items-center justify-between gap-1">
            <button type="button" aria-label={view === "days" ? "Previous month" : "Previous year"}
              disabled={!canGoBack}
              onClick={() => showMonth(view === "days" ? previous : clampMonth(previous, lower, upper))}
              className="tap flex size-11 shrink-0 items-center justify-center rounded-full text-charcoal disabled:opacity-40">
              <Chevron direction="left" />
            </button>
            <button type="button" id={`${id}-title`} aria-expanded={view === "months"}
              aria-label={view === "days" ? `${monthTitle(month)}, choose month and year` : `${heading}, back to days`}
              onClick={() => setView(view === "days" ? "months" : "days")}
              className="tap relative flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-full px-2">
              <AnimatePresence initial={false} mode="popLayout" custom={direction}>
                <motion.span key={heading} aria-live="polite"
                  className="font-display truncate text-[20px] font-normal leading-[26px] tracking-[-0.01em] text-charcoal"
                  initial={{ opacity: 0, y: direction >= 0 ? 8 : -8 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: direction >= 0 ? -8 : 8 }}
                  transition={reduce ? INSTANT : { y: SPRINGS.snappy, opacity: FADES.quick }}>
                  {heading}
                </motion.span>
              </AnimatePresence>
              <motion.span aria-hidden="true" className="flex text-muted"
                animate={{ rotate: view === "months" ? 180 : 0 }} transition={reduce ? INSTANT : SPRINGS.snappy}>
                <Chevron direction="down" />
              </motion.span>
            </button>
            <button type="button" aria-label={view === "days" ? "Next month" : "Next year"}
              disabled={!canGoForward}
              onClick={() => showMonth(view === "days" ? following : clampMonth(following, lower, upper))}
              className="tap flex size-11 shrink-0 items-center justify-center rounded-full text-charcoal disabled:opacity-40">
              <Chevron direction="right" />
            </button>
          </div>

          <div className="relative h-[284px] min-w-0 overflow-hidden">
            <AnimatePresence initial={false}>
              {view === "days" ? (
                <motion.div key="days" className="absolute inset-0" variants={SWAP} initial="hidden" animate="shown"
                  exit="hidden" transition={swap}>
                  <div role="grid" aria-labelledby={`${id}-title`} onKeyDown={onGridKey} className="flex flex-col">
                    <div role="row" className="grid grid-cols-7 pb-1">
                      {INITIALS.map((letter, index) => <span key={index} role="columnheader" aria-label={WEEKDAYS[index]}
                        className="text-center text-[12px] font-medium leading-5 tracking-[0.08em] text-muted">{letter}</span>)}
                    </div>
                    <div className="relative h-[264px]">
                      <AnimatePresence initial={false} custom={direction}>
                        <MonthPanel key={month} month={month} cells={cells} draft={draft} today={today}
                          tabDay={tabDay} outOfRange={outOfRange} direction={direction} transition={slide}
                          lensId={`${id}-lens-${month}`} reduce={reduce ?? false}
                          onChoose={choose} />
                      </AnimatePresence>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="months" className="absolute inset-0" variants={SWAP} initial="hidden" animate="shown"
                  exit="hidden" transition={swap}>
                  <MonthChooser year={month.slice(0, 4)} current={month} disabled={monthOutOfRange}
                    lensId={`${id}-month-lens`} reduce={reduce ?? false}
                    onChoose={(next) => {
                      showMonth(next);
                      if (focusDay.slice(0, 7) !== next) setFocusDay(clampDay(`${next}-01`, lower, upper));
                      setView("days");
                    }} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

const PANEL = {
  enter: (direction: number) => ({ x: direction * 48, opacity: 0, filter: "blur(4px)" }),
  center: { x: 0, opacity: 1, filter: "blur(0px)" },
  exit: (direction: number) => ({ x: direction * -48, opacity: 0, filter: "blur(4px)" }),
};

function MonthPanel({ month, cells, draft, today, tabDay, outOfRange, direction, transition, lensId, reduce,
  onChoose }: {
  month: string; cells: (string | null)[]; draft: string | null; today: string; tabDay: string | null;
  outOfRange(day: string): boolean; direction: number; transition: Transition; lensId: string; reduce: boolean;
  onChoose(day: string): void;
}) {
  const present = useIsPresent();
  const weeks = Array.from({ length: 6 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
  return (
    <motion.div data-month={month} role="rowgroup" custom={direction} variants={PANEL} initial="enter"
      animate="center" exit="exit" transition={transition} inert={!present} aria-hidden={present ? undefined : true}
      className="absolute inset-0 flex flex-col">
      {weeks.map((week, row) => (
        <div key={row} role="row" className="grid h-11 grid-cols-7">
          {week.map((day, column) => {
            if (day === null) return <span key={column} role="gridcell" aria-hidden="true" />;
            const selected = day === draft;
            const isToday = day === today;
            const disabled = outOfRange(day);
            return (
              <span key={day} role="gridcell" aria-selected={selected} className="flex">
                <button type="button" data-date={day} aria-label={`${longDate(day)}${isToday ? ", today" : ""}`}
                  aria-current={isToday ? "date" : undefined} aria-pressed={selected}
                  tabIndex={day === tabDay ? 0 : -1} disabled={disabled} onClick={() => onChoose(day)}
                  className="tap relative flex h-11 min-w-11 flex-1 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40">
                  {selected && <motion.span aria-hidden="true" layoutId={lensId} className="day-lens absolute inset-x-1 inset-y-0"
                    transition={reduce ? INSTANT : SPRINGS.snappy} />}
                  <span className={`relative text-[16px] tabular-nums leading-none transition-colors duration-150 ${
                    selected ? "font-semibold text-on-primary" : isToday ? "font-semibold text-alert" : "text-charcoal"}`}>
                    {Number(day.slice(8, 10))}
                  </span>
                </button>
              </span>
            );
          })}
        </div>
      ))}
    </motion.div>
  );
}

function MonthChooser({ year, current, disabled, lensId, reduce, onChoose }: {
  year: string; current: string; disabled(month: string): boolean; lensId: string; reduce: boolean;
  onChoose(month: string): void;
}) {
  return (
    <div role="group" aria-label={`Months of ${year}`} className="grid h-full grid-cols-3 content-center gap-y-3 px-1">
      {MONTHS.map((name, index) => {
        const month = `${year}-${String(index + 1).padStart(2, "0")}`;
        const selected = month === current;
        return (
          <button key={month} type="button" aria-label={`${name} ${year}`} aria-pressed={selected}
            disabled={disabled(month)} onClick={() => onChoose(month)}
            className="tap relative flex h-11 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40">
            {selected && <motion.span aria-hidden="true" layoutId={lensId} className="day-lens absolute inset-x-2 inset-y-0"
              transition={reduce ? INSTANT : SPRINGS.snappy} />}
            <span className={`relative text-[16px] leading-none ${selected ? "font-semibold text-on-primary" : "text-charcoal"}`}>
              {name.slice(0, 3)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
