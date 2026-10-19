/**
 * Saved, named and dated shopping lists (UI makeover W7, docs/plans/2026-10-19-ui-makeover.md §7.2):
 * the order the switcher's arrows cycle, a list's shown name, and the dates of a new list. Pure.
 */
import { compareLists } from "@/lib/shopping/current";
import { shoppingDate } from "@/lib/shopping/labels";
import type { ShoppingPeriod } from "@/lib/shopping/types";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" });
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && !Number.isNaN(new Date(`${date}T12:00:00Z`).getTime());

/** "20–26 Oct", or "28 Oct – 3 Nov" across a month. */
export function compactRange(start: string, end: string): string {
  if (!valid(start) || !valid(end)) return `${start} – ${end}`;
  if (start === end) return shoppingDate(start);
  const a = new Date(`${start}T12:00:00Z`);
  const b = new Date(`${end}T12:00:00Z`);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
    ? `${DAY.format(a)}–${DAY.format(b)} ${MONTH.format(b)}`
    : `${shoppingDate(start)} – ${shoppingDate(end)}`;
}

/** The name a list shows: its own title, else "List for 20–26 Oct" (never stored). */
export function listName(period: Pick<ShoppingPeriod, "title" | "startDate" | "endDate">): string {
  const title = period.title?.trim();
  return title || `List for ${compactRange(period.startDate, period.endDate)}`;
}

/** Newest first: the order the arrows walk (`startDate` desc, then most recently updated). */
export function cycleOrder<T extends Pick<ShoppingPeriod, "startDate" | "endDate" | "updatedAt">>(
  periods: readonly T[]): T[] {
  return [...periods].sort(compareLists);
}

/** The list `step` places from `currentId` in cycle order; null past either end or with no lists.
 *  With no current list, the newest. */
export function stepList<T extends Pick<ShoppingPeriod, "id" | "startDate" | "endDate" | "updatedAt">>(
  periods: readonly T[], currentId: string | null, step: 1 | -1): T | null {
  const order = cycleOrder(periods);
  if (!order.length) return null;
  const at = order.findIndex((row) => row.id === currentId);
  if (at < 0) return order[0];
  return order[at + step] ?? null;
}

export type NewListSpan = "this_week" | "next_week" | "custom";

function shift(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The dates "New list" starts with: this week (today + 6), next week (+7 … +13), or custom. */
export function newListDates(span: NewListSpan, today: string,
  custom?: { startDate: string; endDate: string }): { startDate: string; endDate: string } {
  if (span === "next_week") return { startDate: shift(today, 7), endDate: shift(today, 13) };
  if (span === "custom" && custom) return custom;
  return { startDate: today, endDate: shift(today, 6) };
}

/** "12 items · 3 in cart" for a list's lines. */
export function progressLine(itemCount: number, checkedCount: number): string {
  if (itemCount === 0) return "No items yet";
  return `${itemCount} ${itemCount === 1 ? "item" : "items"} · ${checkedCount} in cart`;
}
