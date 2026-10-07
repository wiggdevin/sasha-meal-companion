/**
 * Phase 9 §0.1 test seam: every device primitive takes the handle of a bound account, so a test
 * that touches IndexedDB, the store or an outbox writer binds one first. The default account is a
 * fixed UUID; pass another id when the test itself is about which account owns what.
 */
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { closeAllAccountDbs } from "@/lib/sync/idb";

export const TEST_USER = "11111111-1111-4111-8111-111111111111";

/** Close every account database, unbind, and bind `userId` afresh. Call from `beforeEach`. */
export async function resetTestAccount(userId: string = TEST_USER): Promise<AccountHandle> {
  await closeAllAccountDbs();
  unbindAccount();
  return bindAccount(userId);
}
