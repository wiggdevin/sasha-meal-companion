/**
 * Favorites — Phase 3 spec, "Engines and logic". Pure. No I/O.
 *
 * Membership merges by set union and `sort` by the newer `client_ts` (architecture §3.7). The
 * union is a STORE-level rule: two devices each starring a different food write two rows that
 * never conflict, so `mergeEntity` never sees them — this is where both sides are reconciled.
 * A removed favorite carries `deleted_at` and is filtered out before it reaches here, which is
 * why the tombstone columns in 20260919090000 exist: without them the union resurrects it.
 */
export type FavoriteKind = "food" | "recipe" | "meal";

/** One row of the strip. `foodRefId`, `catalogFoodId` and `revisionId` are what the integration
 *  mount needs to hand a pick to the log sheet's existing pick-a-food path; they are absent for
 *  a favorite whose food the user has not opened on this device. */
export type FavoriteRow = {
  kind: FavoriteKind; id: string; name: string; sort: number;
  foodRefId?: string; catalogFoodId?: number | null; revisionId?: number | null;
};

/** Fired on `window` after a screen stars or unstars something, so every favorites view rereads. */
export const FAVORITES_CHANGED_EVENT = "favorites-changed";

/** Spec open question 5: 12 pinned, the rest behind a tap. */
export const PINNED_LIMIT = 12;

export function nextSort(existing: { sort: number }[]): number {
  return existing.reduce((max, row) => Math.max(max, row.sort), 0) + 1;
}

export function mergeFavorites<T extends { key: string; sort: number; clientTs: string }>(
  mine: T[], theirs: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of [...mine, ...theirs]) {
    const seen = byKey.get(row.key);
    if (!seen || Date.parse(row.clientTs) > Date.parse(seen.clientTs)) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

export function pinnedAndRest(
  rows: FavoriteRow[], limit: number = PINNED_LIMIT,
): { pinned: FavoriteRow[]; rest: FavoriteRow[] } {
  const ordered = [...rows].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return { pinned: ordered.slice(0, limit), rest: ordered.slice(limit) };
}
