/**
 * The meals this account has logged before, read from its own days on this phone (W123, T5).
 *
 * Pure, and account-scoped by construction: the store passed in is the bound account's projection
 * (lib/store.ts), so no other account's history can reach a row. Only entries a re-log can rebuild
 * count: the server acknowledged them (`rev`), and every line names a real food ref and a known
 * mass. Anything else stays where it is, never guessed into a new entry.
 */
import type { LoggedFood, StoredDay } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Can this entry be logged again as it stands? */
export function canLogAgain(entry: LoggedFood): boolean {
  if (typeof entry.rev !== "number" || entry.localOnly || entry.notSaved || entry.massUnknown) return false;
  const items = entry.items ?? [];
  return items.length > 0 && items.every((item) => UUID.test(item.food_ref_id)
    && typeof item.grams === "number" && Number.isFinite(item.grams) && item.grams > 0
    && Number.isFinite(item.qty) && item.qty > 0);
}

/** The foods an entry holds, ignoring amounts: the same foods eaten again are the same meal. */
export function foodsKey(refs: readonly string[]): string {
  return [...new Set(refs.map((ref) => ref.toLowerCase()))].sort().join("|");
}

export type RecentMeal = { entry: LoggedFood; date: string };

/**
 * The newest re-loggable entry for each distinct set of foods, newest first. Days on or after
 * `before` are left out when it is given (the day on screen is not "before"), and at most `limit`
 * come back.
 */
export function recentMeals(
  days: Record<string, StoredDay>, opts: { before?: string; limit?: number } = {},
): RecentMeal[] {
  const limit = opts.limit ?? 10;
  const rows: RecentMeal[] = [];
  for (const [date, day] of Object.entries(days)) {
    if (opts.before !== undefined && date >= opts.before) continue;
    for (const entry of day.extras ?? []) if (canLogAgain(entry)) rows.push({ entry, date });
  }
  rows.sort((a, b) => (b.entry.at < a.entry.at ? -1 : b.entry.at > a.entry.at ? 1 : 0));
  const seen = new Set<string>();
  const out: RecentMeal[] = [];
  for (const row of rows) {
    const key = foodsKey((row.entry.items ?? []).map((item) => item.food_ref_id));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * "You logged this before": the newest earlier entry holding exactly these foods. Every ref must
 * be known — a capture line nobody has matched to a food yet makes no claim.
 */
export function loggedBefore(
  days: Record<string, StoredDay>, refs: readonly (string | null)[], before?: string,
): RecentMeal | null {
  if (refs.length === 0 || refs.some((ref) => ref === null || !UUID.test(ref))) return null;
  const key = foodsKey(refs as string[]);
  return recentMeals(days, { before, limit: Number.POSITIVE_INFINITY })
    .find((row) => foodsKey((row.entry.items ?? []).map((item) => item.food_ref_id)) === key) ?? null;
}
