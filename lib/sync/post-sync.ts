/**
 * The catch-up work that only a SUCCESSFUL sync licenses.
 *
 * Both halves need a session and neither can be driven by the outbox: a pref for a food the user marked
 * before T1 shipped, and a morning weight typed while the phone had no signal. A sync that just
 * succeeded is the first honest evidence the server can be reached as them, which is why this hangs
 * off `syncOnce(h)` resolving rather than off a timer.
 *
 * It lives here rather than inside `components/SyncBootstrap.tsx` because that is an effect body,
 * and this repo has no DOM test environment — `renderToStaticMarkup` never runs an effect, so code
 * written there cannot be exercised at all.
 *
 * Neither half may stop the other, and awaiting them in order is not enough for that: a backfill
 * that is merely SLOW — or one that never answers at all — strands every parked weigh-in behind it,
 * which is the opposite of what this comment used to promise. They start together and settle
 * independently.
 */
import type { AccountHandle } from "@/lib/device/account";
import type { Food } from "@/lib/foods";
import { backfillFoodPrefs } from "@/lib/foods/prefs-client";
import { drainWorldOpenPending } from "@/lib/foods/world-open-client";
import { drainWeighIns } from "@/lib/health/weigh-in-client";
import { drainDeferredPicks } from "@/lib/log/picked-deferred";
import { retryPendingReconciles } from "@/lib/log/reconcile";
import { syncOnce } from "@/lib/sync/client";

/**
 * One sync pass, and the catch-up a successful one licenses. `components/SyncBootstrap.tsx` calls
 * exactly this and nothing else, so the "did the sync actually lead to the drain" wiring is a
 * function with a test rather than three lines inside an effect that no test can reach.
 *
 * A FAILED sync licenses nothing: offline or signed out, the outbox keeps the write and backs off.
 */
export async function syncThenCatchUp(h: AccountHandle, foods: () => Record<string, Food>): Promise<void> {
  await syncOnce(h);
  await catchUpAfterSync(h, foods());
}

export async function catchUpAfterSync(h: AccountHandle, foods: Record<string, Food>): Promise<void> {
  await Promise.allSettled([
    // 20 foods a run means 53 take three syncs, and a mark made in airplane mode has to be picked
    // up whenever signal comes back. A caught-up cache costs one claims read and a filter.
    backfillFoodPrefs(h, foods),
    // Account-scoped inside `drainWeighIns`: the pending records carry the user that parked them,
    // so a second account signing in on this phone never posts the first one's weight under its
    // JWT. It has its own deadline, so this one cannot hang either.
    drainWeighIns(h),
    // Entries the server has taken but this phone could not read back yet. One read each, no
    // post: their ops are already gone, and the mark is what keeps Today honest until the row
    // arrives (Grok pass 4, HIGH 2).
    retryPendingReconciles(h),
    // Picked logs that were waiting for a food ref (a first use offline, a non-ready pick in a
    // meal): the refs are minted now, through the ref registry, and each entry is committed whole.
    drainDeferredPicks(h),
    // W13 (D14): onboarding's open-world intent, re-posted until the server settles it, so a 503
    // or a not-yet-synced settings row at completion never leaves a new account closed for good.
    drainWorldOpenPending(h),
  ]);
}
