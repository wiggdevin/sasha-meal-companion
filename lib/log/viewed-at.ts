/**
 * When a meal logged from Today was eaten (UI audit 2026-10-07): now while the day on screen is
 * today, else the slot's own clock time on the day on screen, in the phone's zone. A log from a past
 * day's meal card was filed under today and never shown on the day the person had open.
 *
 * A clock time the zone skips that day (the spring DST gap, 02:30 in Los Angeles) moves forward by
 * the gap, as the platform's local-time parse does (03:30 that day).
 */
export function viewedLogAt(viewedDate: string, todayIso: string, slotTime?: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(viewedDate) || viewedDate === todayIso) return undefined;
  const time = slotTime && /^\d{2}:\d{2}$/.test(slotTime) ? slotTime : "12:00";
  return new Date(`${viewedDate}T${time}:00`);
}
