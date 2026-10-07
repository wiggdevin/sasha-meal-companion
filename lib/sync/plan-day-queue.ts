const pendingDates = new Map<string, Promise<void>>();

/** Phase 9 §0.3: the next account starts with no queued date. In-flight work stops at its own
 *  handle check. */
export function resetPlanDayQueue(): void {
  pendingDates.clear();
}

/** Test-only: how many dates have queued work. */
export function __pendingDateCount(): number {
  return pendingDates.size;
}

/** Local writers and remote projections share one date queue. Failure releases the next caller. */
export function serializePlanDay<T>(date: string, work: () => Promise<T>): Promise<T> {
  const result = (pendingDates.get(date) ?? Promise.resolve()).then(work);
  const settled = result.then(() => {}, () => {});
  pendingDates.set(date, settled);
  void settled.then(() => {
    if (pendingDates.get(date) === settled) pendingDates.delete(date);
  });
  return result;
}
