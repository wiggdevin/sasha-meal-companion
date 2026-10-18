/**
 * The words and dates the Shopping screens show (UI audit 2026-10-18 §4): one date format, one
 * meal name, one name per list group and per picker source, and money as money. Pure. No I/O.
 */
import type { ShoppingLine, ShoppingPurchaseWindow } from "@/lib/shopping/types";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "18 Oct". A value that is not a calendar date is shown as it came. */
export function shoppingDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(parsed.getTime()) ? DAY.format(parsed) : date;
}

/** "18 Oct – 24 Oct". */
export function shoppingRange(start: string, end: string): string {
  return `${shoppingDate(start)} – ${shoppingDate(end)}`;
}

/** "Meal 2", or a stored slot id made readable ("late_snack" → "Late Snack"). */
export function mealLabel(slot: string): string {
  return /^meal-[1-6]$/.test(slot) ? `Meal ${slot.slice(5)}`
    : slot.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The list's own group headings. */
export const CATEGORY_LABEL: Record<ShoppingLine["category"], string> = {
  core: "For your meals",
  pantry_top_up: "Pantry top-ups",
  optional_extra: "Optional extras",
  manual: "Added by you",
};

/** Where a plan-ingredient choice came from. */
export const SOURCE_LABEL: Record<string, string> = {
  favorite: "Favorite",
  list: "On your list",
  pantry: "In your pantry",
  search: "Search result",
};

/** "$42.50", or the amount with its code when the code is not a currency the phone knows. */
export function formatMoney(amount: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
    } catch { return `${currency} ${amount.toFixed(2)}`; }
  }
  return amount.toFixed(2);
}

/**
 * A monthly list ticks plan items per week. A plan line counts as bought when the week covering
 * `today` is ticked (the latest week started by then); before the list starts, its first week.
 * A line with no weeks has no answer here (null).
 */
export function currentWindowChecked(lineId: string, windows: readonly ShoppingPurchaseWindow[],
  today: string): boolean | null {
  const own = windows.filter((row) => row.lineId === lineId)
    .sort((a, b) => a.windowStartDate.localeCompare(b.windowStartDate));
  if (!own.length) return null;
  const current = own.filter((row) => row.windowStartDate <= today).at(-1) ?? own[0];
  return current.checked;
}

/** The phone's own date, as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
