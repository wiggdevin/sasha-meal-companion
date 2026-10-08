import type { AccountHandle } from "@/lib/device/account";
import { readAccountItem, writeAccountItem } from "@/lib/device/account-storage";

/**
 * The first-run overview's "seen" mark: one value per account on this device, in the
 * account-scoped storage (`smc:u:<id>:tour:seen`), so a second account on the phone still gets its
 * own first run. It is a convenience, not account data: a blocked or full storage reads as "not
 * seen" and a lost write only means the overview could show once more. Nothing here throws.
 */
export const TOUR_SEEN_NAME = "tour:seen:v1";

export function hasSeenTour(h: AccountHandle): boolean {
  return readAccountItem(h, TOUR_SEEN_NAME) !== null;
}

export function markTourSeen(h: AccountHandle, now: Date = new Date()): void {
  try {
    writeAccountItem(h, TOUR_SEEN_NAME, now.toISOString());
  } catch {
    // The account changed under us: the mark belongs to the account that left, so it is dropped.
  }
}

/** False when this device keeps nothing (storage blocked): the mark could never be kept, so the
 *  overview never opens by itself there rather than opening on every visit. */
export function tourStorageUsable(): boolean {
  try {
    return typeof localStorage !== "undefined" && typeof localStorage.length === "number";
  } catch {
    return false;
  }
}

/** Show it by itself only once onboarding is complete and this account has not seen it here. */
export function shouldAutoOpenTour(input: { onboardedAt: string | null | undefined; seen: boolean }): boolean {
  return Boolean(input.onboardedAt) && !input.seen;
}
