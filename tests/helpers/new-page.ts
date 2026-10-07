/**
 * Phase 9 slice 1, reload boundary: an account change is a new page. These helpers give a test
 * that page: every module-level value is dropped (as a reload drops it); localStorage and
 * IndexedDB stay (as a reload keeps them). Tests that need real fresh modules use
 * `vi.resetModules()` instead (tests/device/departure.test.ts).
 */
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { __resetBoot } from "@/lib/device/boot";
import { __resetDeparture } from "@/lib/device/departure";
import { __releaseWriter } from "@/lib/device/writer-lock";
import { resetStoreCache } from "@/lib/store";
import { resetFoodRefCache } from "@/lib/log-client";
import { resetPlanDayQueue } from "@/lib/sync/plan-day-queue";
import { resetSyncPasses } from "@/lib/sync/client";
import { resetApplyState } from "@/lib/coach/apply-client";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { resetNoteSaves } from "@/lib/log-note-client";
import { resetWeighInDrains } from "@/lib/health/weigh-in-client";
import { resetPrefsState } from "@/lib/foods/prefs-client";
import { resetCapabilityCache } from "@/lib/health/capability";
import { closeAllAccountDbs } from "@/lib/sync/idb";

/** Drop every module-level value that holds account data. */
export function resetAccountMemory(): void {
  resetStoreCache();
  resetFoodRefCache();
  resetPlanDayQueue();
  resetSyncPasses();
  resetApplyState();
  resetLiveCommits();
  resetNoteSaves();
  resetWeighInDrains();
  resetPrefsState();
  resetCapabilityCache();
}

/** A fresh page bound to `userId` (or to nobody). */
export async function newPage(userId: string | null): Promise<AccountHandle | null> {
  await closeAllAccountDbs();
  unbindAccount();
  resetAccountMemory();
  __resetDeparture();
  __resetBoot();
  __releaseWriter();
  return userId === null ? null : bindAccount(userId);
}

/** A Web Locks manager that grants every ask at once (one tab per test). Without one, jsdom has
 *  no `navigator.locks` and the writer claim falls back to the slower localStorage lease. */
export function grantAllLocks(): void {
  const locks = {
    request: (name: string, _opts: unknown, cb: (lock: unknown) => unknown) =>
      Promise.resolve(cb({ name })),
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}
