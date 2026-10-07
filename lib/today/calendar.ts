import type { ResolvedDay } from "@/lib/types";

/** Calendar arithmetic, never elapsed milliseconds: DST cannot shift a day. */
export function shiftCalendarDay(date: string, offset: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(year, month - 1, day, 12);
  next.setDate(next.getDate() + offset);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

export function mondayFor(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return shiftCalendarDay(date, -((new Date(year, month - 1, day, 12).getDay() + 6) % 7));
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
}

export function weekCaption(monday: string): string {
  const sunday = shiftCalendarDay(monday, 6);
  const month = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  return monday.slice(0, 7) === sunday.slice(0, 7) ? month(monday) : `${month(monday)} – ${month(sunday)}`;
}

export type DayCompletionStatus = "unplanned" | "not due yet" | "missed" | "all done" | "partially done";

/** Same completion rules as WeekGrid: the optional hot chocolate never blocks a done day. */
export function completionFor(day: ResolvedDay, today: string): DayCompletionStatus {
  if (day.date > today) return "not due yet";
  const required = day.slots.filter((slot) => slot.slot !== "hot-chocolate" && slot.meal !== null);
  if (required.length === 0) return day.extras.length > 0 ? "partially done" : "unplanned";
  const eaten = required.filter((slot) => slot.eaten).length;
  if (eaten === 0) return day.date === today ? "not due yet" : "missed";
  return eaten === required.length ? "all done" : "partially done";
}

/**
 * The Day card's heading for a viewed day (2026-10-01): "Today" over the full date, or the weekday
 * over the day and month. The year shows only when it is not the current one.
 */
export function dayHeading(date: string, today: string): { title: string; subtitle: string; short: string } {
  const weekday = WEEKDAYS[weekdayIndex(date)];
  const day = Number(date.slice(-2));
  const month = MONTHS[Number(date.slice(5, 7)) - 1];
  const year = date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`;
  const offset = Math.round((Date.parse(`${date}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / 86_400_000);
  const title = date === today ? "Today" : offset === -1 ? "Yesterday" : offset === 1 ? "Tomorrow" : weekday;
  const named = title !== weekday;
  // The short form ("Mon 5 Oct") is for a heading too narrow for the full one; nothing is cut off.
  return {
    title,
    subtitle: `${named ? `${weekday} ` : ""}${day} ${month}${year}`,
    short: `${named ? `${weekday.slice(0, 3)} ` : ""}${day} ${month.slice(0, 3)}${year}`,
  };
}
