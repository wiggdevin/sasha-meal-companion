/**
 * The one "current list" rule (UI makeover W7, docs/plans/2026-10-19-ui-makeover.md §7.2). Lists
 * may overlap in dates, so every reader that means "my list" picks the same one: among the live
 * lists covering `today`, the latest `startDate`, then the most recently updated. Null when no
 * list covers today. Callers pass live lists only (the period GET never returns a deleted one).
 */
export type DatedList = { startDate: string; endDate: string; updatedAt?: string | null };

/** Newest first: `startDate` descending, then `updatedAt` descending (a missing time sorts last). */
export function compareLists(a: DatedList, b: DatedList): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? 1 : -1;
  const at = a.updatedAt ?? "";
  const bt = b.updatedAt ?? "";
  return at === bt ? 0 : at < bt ? 1 : -1;
}

export function currentShoppingPeriod<T extends DatedList>(periods: readonly T[], today: string): T | null {
  const covering = periods.filter((row) => row.startDate <= today && row.endDate >= today);
  return covering.length ? [...covering].sort(compareLists)[0] : null;
}
