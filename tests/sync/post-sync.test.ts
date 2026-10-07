/**
 * T8: the pending weigh-ins have to be drained by something, and the only honest trigger is a sync
 * that has just succeeded. `components/SyncBootstrap.tsx` calls `syncThenCatchUp` and nothing else,
 * so the wiring itself — sync, then drain, and only on success — is what this file drives.
 *
 * The three modules are mocked because the point under test is the sequence. Which records the
 * drain is allowed to touch, and what it does when the account changed underneath it, belongs to
 * `drainWeighIns` and is covered in tests/health/weigh-in-client.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Food } from "@/lib/foods";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const backfill = vi.fn();
const drain = vi.fn();
const syncOnce = vi.fn();
const retryPendingReconciles = vi.fn();
const drainDeferredPicks = vi.fn();
vi.mock("@/lib/foods/prefs-client", () => ({
  backfillFoodPrefs: (_h: unknown, f: unknown) => backfill(f),
}));
vi.mock("@/lib/health/weigh-in-client", () => ({ drainWeighIns: () => drain() }));
vi.mock("@/lib/sync/client", () => ({ syncOnce: () => syncOnce() }));
vi.mock("@/lib/log/reconcile", () => ({ retryPendingReconciles: () => retryPendingReconciles() }));
vi.mock("@/lib/log/picked-deferred", () => ({ drainDeferredPicks: () => drainDeferredPicks() }));

const { catchUpAfterSync, syncThenCatchUp } = await import("@/lib/sync/post-sync");

const FOODS = { rice: { id: "rice" } as unknown as Food };

let h: AccountHandle;

beforeEach(async () => {
  h = await resetTestAccount();
  backfill.mockReset().mockResolvedValue({ synced: 0, skipped: 0 });
  drain.mockReset().mockResolvedValue({ posted: 0, pending: 0 });
  syncOnce.mockReset().mockResolvedValue(undefined);
  retryPendingReconciles.mockReset().mockResolvedValue(undefined);
  drainDeferredPicks.mockReset().mockResolvedValue({ committed: [], waiting: [] });
});

describe("the sync pass the app runs on open, on focus and when signal returns", () => {
  it("drains the parked weigh-ins once the sync has succeeded", async () => {
    await syncThenCatchUp(h, () => FOODS);
    expect(syncOnce).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith(FOODS);
    // t17: picked logs waiting for a food ref upgrade on the same licence.
    expect(drainDeferredPicks).toHaveBeenCalledTimes(1);
  });

  /** A failed sync licenses nothing: there is no evidence the route can be reached as her. */
  it("drains nothing when the sync failed", async () => {
    syncOnce.mockRejectedValue(new Error("offline"));
    await expect(syncThenCatchUp(h, () => FOODS)).rejects.toThrow("offline");
    expect(drain).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
    expect(drainDeferredPicks).not.toHaveBeenCalled();
  });

  /** Read at the moment of the catch-up, not when the pass was scheduled. */
  it("reads her foods after the sync, not before it", async () => {
    const order: string[] = [];
    syncOnce.mockImplementation(async () => { order.push("sync"); });
    await syncThenCatchUp(h, () => { order.push("foods"); return FOODS; });
    expect(order).toEqual(["sync", "foods"]);
  });
});

describe("the catch-up itself", () => {
  /**
   * "Neither half may stop the other" was the comment, but awaiting them in order meant a backfill
   * that never answers stranded every parked weigh-in behind it. They are independent catch-ups.
   */
  it("drains even when the pref backfill never answers", async () => {
    backfill.mockReturnValue(new Promise(() => {}));
    const done = catchUpAfterSync(h, FOODS);
    await Promise.race([done, new Promise((r) => setTimeout(r, 0))]);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("still drains when the pref backfill fails", async () => {
    backfill.mockRejectedValue(new Error("offline"));
    await expect(catchUpAfterSync(h, FOODS)).resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("does not let a failed drain escape into the sync pass", async () => {
    drain.mockRejectedValue(new Error("offline"));
    await expect(catchUpAfterSync(h, FOODS)).resolves.toBeUndefined();
  });
});
