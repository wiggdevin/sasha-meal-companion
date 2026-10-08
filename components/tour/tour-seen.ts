import type { AccountHandle } from "@/lib/device/account";
import { readAccountItem, removeAccountItem, writeAccountItem } from "@/lib/device/account-storage";

/**
 * The first-run overview's "seen" mark: one value per account on this device, in the
 * account-scoped storage (`smc:u:<id>:tour:seen:v1`), so a second account on the phone still gets
 * its own first run. It is a convenience, not account data: storage that cannot be proven to work
 * never auto-opens the overview (readTourSeen). Nothing here throws.
 */
export const TOUR_SEEN_NAME = "tour:seen:v1";

export function hasSeenTour(h: AccountHandle): boolean {
  return readAccountItem(h, TOUR_SEEN_NAME) !== null;
}

const PROBE_NAME = "tour:probe";

/**
 * What this device can say about the mark. `unseen` needs a positive answer: no mark, and a probe
 * written and read back in the account's storage. A read that fails reads as null in
 * account-storage, so "no mark" alone is not proof; anything that cannot be proven is `unknown`, and
 * the overview never opens by itself on an unknown (Sol, round 1).
 */
export function readTourSeen(h: AccountHandle): "seen" | "unseen" | "unknown" {
  try {
    if (readAccountItem(h, TOUR_SEEN_NAME) !== null) return "seen";
    const probe = String(Date.now());
    writeAccountItem(h, PROBE_NAME, probe);
    const back = readAccountItem(h, PROBE_NAME);
    removeAccountItem(h, PROBE_NAME);
    return back === probe ? "unseen" : "unknown";
  } catch {
    return "unknown";
  }
}

export function markTourSeen(h: AccountHandle, now: Date = new Date()): void {
  try {
    writeAccountItem(h, TOUR_SEEN_NAME, now.toISOString());
  } catch {
    // The account changed under us: the mark belongs to the account that left, so it is dropped.
  }
}

/** Show it by itself only once onboarding is complete and this device proved the account has not seen it. */
export function shouldAutoOpenTour(input: { onboardedAt: string | null | undefined; seen: "seen" | "unseen" | "unknown" }): boolean {
  return Boolean(input.onboardedAt) && input.seen === "unseen";
}
