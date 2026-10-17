/**
 * "Log again" (W123, T5): an earlier entry, logged as a new one now.
 *
 * A NEW entry — new entry id, new item ids, today's clock — through the one durable commit path,
 * so it is pending, retried and reconciled like any other log. Its foods and grams are the old
 * entry's; its nutrients and rule marks are the server's answer now, under the account's current
 * rules (logging marks, never refuses: ruling 2026-09-14). The old entry is never touched.
 */
import { buildCommitRequest } from "@/lib/log-client";
import { commitLogEntry, type CommitResult } from "@/lib/log-commit-client";
import { canLogAgain } from "@/lib/log/recent-meals";
import type { LoggedFood } from "@/lib/types";

/** The request and the card for a re-log, or null when the entry cannot be rebuilt as it stands. */
export function logAgainRequest(entry: LoggedFood, at: Date, tz: string) {
  if (!canLogAgain(entry)) return null;
  const entryId = crypto.randomUUID();
  const items = (entry.items ?? []).map((item, index) => ({ ...item, id: crypto.randomUUID(), seq: index + 1 }));
  const req = buildCommitRequest({
    entryId, eatenAt: at, tz, slot: entry.slot ?? "snack", title: entry.name,
    items: items.map((item) => ({ id: item.id, foodRefId: item.food_ref_id,
      revision: { revision_id: null }, grams: item.grams, qty: item.qty, unit: item.unit })),
  });
  // The old card's display, under the new ids; its marks and revision are the old entry's, not
  // this one's, so they go and the server's answer sets them again.
  const card: LoggedFood = {
    id: entryId, foodId: entry.foodId, name: entry.name, slot: req.slot, portionLabel: entry.portionLabel,
    qty: entry.qty, grams: entry.grams, macros: entry.macros, items, at: req.eaten_at,
  };
  return { req, card };
}

/** Commit the re-log. `null`: nothing was sent, because the entry cannot be rebuilt. */
export async function logAgain(
  entry: LoggedFood, at: Date = new Date(), tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<{ result: CommitResult; date: string; card: LoggedFood } | null> {
  const built = logAgainRequest(entry, at, tz);
  if (built === null) return null;
  const date = built.req.local_date;
  const result = await commitLogEntry(built.req,
    { optimistic: { date, entry: built.card }, timingPath: "meal-log" });
  return { result, date, card: built.card };
}
