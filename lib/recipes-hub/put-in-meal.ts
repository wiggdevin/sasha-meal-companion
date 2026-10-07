/**
 * "Put it in a meal" (owner ask 2026-10-03): the rules behind the in-place picker on a recipe card or
 * detail — the seven day chips (today and the next six), the meal slots of a day's layout with their
 * time and whether each is empty or planned, and which slot is chosen first. The write itself is the
 * catalog's recipe plan path (lib/recipe-plan-client.ts), called only from the picker's confirm.
 *
 * Pure. No I/O.
 */

import type { ResolvedSlot } from "@/lib/types";

/** The recipe plan API places into meal-1 … meal-6 only (lib/shopping/preview-contract.ts mealSlot). */
const MEAL_SLOT = /^meal-[1-6]$/;

/** A calendar date ("2026-10-03") in the device's zone. */
export function localDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Calendar arithmetic on "YYYY-MM-DD", at noon UTC so no zone or DST shift can move the day. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export type DayChoice = { date: string; label: string; day: string; name: string };

const weekday = (date: string, style: "short" | "long") => new Intl.DateTimeFormat("en-US",
  { weekday: style, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

function dayChoice(date: string, today: string): DayChoice {
  const long = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric",
    timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const isToday = date === today;
  return { date, label: isToday ? "Today" : weekday(date, "short"), day: String(Number(date.slice(8))),
    name: isToday ? `Today, ${long}` : long };
}

/**
 * Today and the next `count - 1` days: "Today 3", "Sun 4" …, each with a full spoken name. A viewed
 * day outside that window leads the row, so the default day is always on screen.
 */
export function dayChoices(today: string, count = 7, viewed?: string | null): DayChoice[] {
  const week = Array.from({ length: count }, (_, index) => dayChoice(addDays(today, index), today));
  return viewed && !week.some((day) => day.date === viewed) ? [dayChoice(viewed, today), ...week] : week;
}

/** "Today" or "Saturday", for the confirm button and the success line. */
export function dayName(date: string, today: string): string {
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  return weekday(date, "long");
}

/** "08:00" → "8:00 am". Display only. */
export function clock12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
}

export type SlotChoice = { slotId: string; label: string; time: string; planned: string | null; eaten: boolean };

/** The day's meal slots in time order, each with what is planned there now (null when empty). */
export function slotChoices(slots: readonly Pick<ResolvedSlot, "slot" | "label" | "time" | "meal" | "eaten">[]): SlotChoice[] {
  return slots.filter((slot) => MEAL_SLOT.test(slot.slot))
    .map((slot) => ({ slotId: slot.slot, label: slot.label || `Meal ${slot.slot.slice(5)}`, time: slot.time,
      planned: slot.meal?.name?.trim() || null, eaten: slot.eaten }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** What a slot chip says under its name: "Empty", "Chicken & rice", or "Eaten". */
export function slotState(choice: SlotChoice): string {
  if (choice.eaten) return "Eaten";
  return choice.planned ?? "Empty";
}

/**
 * The slot chosen when the picker opens or the day changes: the one asked for (the meal being
 * viewed), else the first empty slot, else nothing — a planned slot is never pre-chosen, so a
 * replacement is always the person's own pick. Eaten slots are never chosen.
 */
export function defaultSlot(choices: readonly SlotChoice[], wanted?: string | null): string | null {
  const open = choices.filter((choice) => !choice.eaten);
  if (wanted && open.some((choice) => choice.slotId === wanted)) return wanted;
  return open.find((choice) => choice.planned === null)?.slotId ?? null;
}
