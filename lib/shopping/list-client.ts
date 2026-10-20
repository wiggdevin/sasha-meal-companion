/**
 * Saved-list management on the phone: rename and delete a shopping period (UI makeover W7,
 * docs/plans/2026-10-19-ui-makeover.md §7.2). Both go through the period routes with the
 * commit deadline (`accountFetch`'s budget), on the revision the caller last saw; a repeat with the same `requestId`
 * after a lost answer is answered as done.
 */
import { accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { ShoppingRequestFailed, ShoppingStaleRevision } from "@/lib/shopping-client";
import type { ShoppingPeriod } from "@/lib/shopping/types";

function periodPath(id: string): string {
  return `/api/shopping/periods/${encodeURIComponent(id)}`;
}

async function send<T>(path: string, method: "PATCH" | "DELETE", value: unknown,
  h: AccountHandle = accountHandle()): Promise<T> {
  const res = await accountFetch(h, path, { method, cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(value) },
  { budget: "commit" });
  if (!res.ok) {
    if (res.status === 409) throw new ShoppingStaleRevision();
    throw new ShoppingRequestFailed(res.status === 404 ? "This list is gone. Refresh your lists."
      : `That didn't save (${res.status}). Try again.`, res.status);
  }
  return accountJson<T>(h, res);
}

/** Renames a list (`null` clears its title), on the revision the caller last saw. */
export async function renameShoppingPeriod(id: string, title: string | null,
  expectedRevision: number, requestId: string, h?: AccountHandle): Promise<ShoppingPeriod> {
  const trimmed = title === null ? null : title.trim() || null;
  const answer = await send<{ period: ShoppingPeriod }>(periodPath(id), "PATCH",
    { expectedRevision, requestId, patch: { title: trimmed } }, h);
  return answer.period;
}

/** Deletes a list, on the revision the caller last saw. */
export async function deleteShoppingPeriod(id: string, expectedRevision: number,
  requestId: string, h?: AccountHandle): Promise<void> {
  // A held delete passes the account it was made under, never the one bound when it is sent.
  await send<{ deleted: true }>(periodPath(id), "DELETE", { expectedRevision, requestId }, h);
}
