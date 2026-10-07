/**
 * The card's "try again", for a write nothing ever confirmed.
 *
 * Its own module so lib/log-commit-client.ts stays under 400 lines: this is recovery, like the
 * catch-up and the delete, rather than part of sending a commit.
 */
import { accountHandle } from "@/lib/device/account";
import { commitLogEntry, type CommitResult } from "@/lib/log-commit-client";
import { isCommitting } from "@/lib/log/live-commits";
import { clearPending, unsavedRequest } from "@/lib/log/pending";
import { getDay } from "@/lib/store";
import { getRow } from "@/lib/sync/idb";

/**
 * The user tapped "try again" on a card nothing ever confirmed. The record kept the request for
 * exactly this, because the queued change it would otherwise be rebuilt from is what went missing.
 */
export async function retryUnsavedCommit(
  entryId: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<CommitResult | null> {
  const h = accountHandle();
  // A live commit and this control are two ways to send one entry. While one is in the air the
  // other does nothing at all — not even join it, since a tap that waits on a hung request is a
  // tap that looks broken (Grok pass 9, HIGH 2).
  if (await isCommitting(entryId)) return null;
  const request = await unsavedRequest(h, entryId);
  if (request === null) return null;
  const date = request.local_date;
  const entry = getDay(date)?.extras?.find((extra) => extra.id === entryId);
  // The user has taken the card off the day, or the server has the entry and says it is deleted.
  // Either way there is nothing left to save (Grok pass 9, MEDIUM 5).
  const mirrored = await getRow(h, "log_entries", entryId).catch(() => undefined);
  if (!entry || mirrored?.deleted_at) {
    await clearPending(h, entryId);
    return null;
  }
  return commitLogEntry(request, {
    account: h,
    fetchImpl: opts.fetchImpl,
    ...(entry ? { optimistic: { date, entry } } : {}),
  });
}
