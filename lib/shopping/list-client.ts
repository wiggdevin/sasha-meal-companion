/**
 * Saved-list management on the phone: rename and delete a shopping period (UI makeover W0 stub).
 * The signatures are frozen; both throw until the routes land.
 */
import type { ShoppingPeriod } from "@/lib/shopping/types";

/** Renames a list (`null` clears its title), on the revision the caller last saw. */
export async function renameShoppingPeriod(_id: string, _title: string | null,
  _expectedRevision: number, _requestId: string): Promise<ShoppingPeriod> {
  throw new Error("not_implemented");
}

/** Deletes a list, on the revision the caller last saw. */
export async function deleteShoppingPeriod(_id: string, _expectedRevision: number,
  _requestId: string): Promise<void> {
  throw new Error("not_implemented");
}
