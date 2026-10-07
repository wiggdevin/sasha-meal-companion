"use client";

import { useRef } from "react";
import { motion } from "motion/react";
import { MONTHS, WEEKDAYS, shiftCalendarDay, weekdayIndex } from "@/lib/today/calendar";
import { SPRINGS } from "@/lib/design/motion";

export type TodayMonthCalendarProps = {
  date: string;
  start: string;
  today: string;
  onSelect(date: string, at: number): void;
  onClose(): void;
  dayStatus(date: string): { label: string; dot: string };
  reducedMotion?: boolean;
};

const INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * Four additional rows of the same seven-column week, never a second picker (2026-10-01: the
 * weekday names sit once above the grid, each cell keeps its name for screen readers). The chosen
 * day wears the strip's olive lens; picking another date glides the lens there.
 */
export default function TodayMonthCalendar({ date, start, today, onSelect, onClose, dayStatus,
  reducedMotion = false }: TodayMonthCalendarProps) {
  const grid = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 28 }, (_, index) => shiftCalendarDay(start, index + 7));

  return (
    <div data-month-calendar role="group" aria-label="Following four weeks"
      className={`overflow-x-auto overscroll-x-contain px-1 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${reducedMotion ? "" : "today-month-enter"}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}>
      <div className="min-w-[308px] border-t border-hairline pt-2">
        <div aria-hidden="true" className="grid grid-cols-7 pb-1">
          {INITIALS.map((letter, index) => <span key={index}
            className="text-center text-[12px] font-medium tracking-[0.08em] text-muted">{letter}</span>)}
        </div>
        <div ref={grid} className="grid grid-cols-7">
          {days.map((day) => {
            const weekday = weekdayIndex(day);
            const status = dayStatus(day);
            const active = day === date;
            const isToday = day === today;
            return <button key={day} type="button" data-date={day}
              aria-label={`${WEEKDAYS[weekday]} ${Number(day.slice(-2))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}, ${status.label}`}
              aria-pressed={active} aria-current={isToday ? "date" : undefined}
              tabIndex={day === days[0] ? 0 : -1}
              onClick={(event) => onSelect(day, event.timeStamp)}
              onKeyDown={(event) => {
                const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
                if (offset === undefined) return;
                event.preventDefault();
                const next = shiftCalendarDay(day, offset);
                grid.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus();
              }}
              className="tap relative flex h-14 min-w-11 flex-col items-center justify-center gap-1 rounded-full focus-visible:outline-2 focus-visible:outline-primary">
              {active && <motion.span aria-hidden="true" layoutId="month-lens" className="day-lens absolute inset-x-1 inset-y-0.5"
                transition={reducedMotion ? { duration: 0 } : SPRINGS.snappy} />}
              <span className="sr-only">{WEEKDAYS[weekday].slice(0, 3)}</span>
              {/* A new month announces itself above its first day. */}
              {day.endsWith("-01") && <span aria-hidden="true"
                className={`absolute top-0.5 text-[12px] font-semibold leading-none ${active ? "text-on-primary" : "text-primary"}`}>
                {MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)}
              </span>}
              <span className={`relative text-[16px] tabular-nums leading-none transition-colors duration-150 ${
                active ? "font-semibold text-on-primary" : isToday ? "font-semibold text-alert" : "text-charcoal"}`}>
                {Number(day.slice(-2))}
              </span>
              <span aria-hidden="true" className="relative h-1.5 w-1.5 rounded-full" style={{ background: status.dot }} />
            </button>;
          })}
        </div>
      </div>
    </div>
  );
}
