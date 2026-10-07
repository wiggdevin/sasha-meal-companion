/**
 * Sync for one ready account (Phase 9 §0.3; plan decision P6). The body of the old `SyncBootstrap`
 * effect, per handle, so a test can drive it without a DOM render.
 *
 * Runs a sync pass on ready, on return to the tab, when signal comes back, and 1.5 s after a local
 * write. "A local write" means two things: a lib/store save, and an op queued in the outbox
 * (water, favorites, recipes, body profile and the estimator write only to the outbox). Both feed
 * the same debounce, so a burst of writes still costs one pass.
 *
 * On start, on return to the tab and at local midnight the target cache is re-resolved for the
 * local day (lib/targets/day-roll.ts, t24b), with no network.
 *
 * Each pass is followed by a send of the queued coach Undo records and marks
 * (lib/coach/undo-client.ts), so a record queued while offline reaches the server on app start,
 * return to the tab, reconnect and after local writes — not only when someone taps Undo.
 *
 * Nothing runs before the account is ready (legacy adoption finished) and nothing runs after it is
 * gone: `mountAccountSync` starts one `startAccountSync` per ready event and stops it on gone.
 */
import { flushPendingUndos } from "@/lib/coach/undo-client";
import { onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import { loadStore, setOnSave, setOnScheduleEdit } from "@/lib/store";
import { pingWarm } from "@/lib/warm-client";
import { msUntilNextLocalDay, targetDayRoll } from "@/lib/targets/day-roll";
import { restoreCachedPlanDays } from "./plan-cache";
import { SYNCED_EVENT } from "./client";
import { OUTBOX_QUEUED_EVENT } from "./outbox";
import { queueScheduleEdit } from "./schedule-settings";
import { syncThenCatchUp } from "./post-sync";

const SAVE_DEBOUNCE_MS = 1500;

export type AccountSyncDeps = {
  /** One pass plus its catch-up. Default: `syncThenCatchUp(h, …)`. */
  run?: (h: AccountHandle) => Promise<void>;
  /** The window to listen on. Default: the global one. */
  win?: Window;
  /** Queues a schedule edit onto user_settings. Default: `queueScheduleEdit`. */
  queueSchedule?: typeof queueScheduleEdit;
  /** Sends queued coach Undo records. Default: `flushPendingUndos(h)`. */
  flushUndos?: (h: AccountHandle) => Promise<void>;
  /** Re-resolves the target cache on a new local day (t24b). Default: `targetDayRoll(h)`. */
  rollTargetDay?: () => boolean;
};

function defaultRun(h: AccountHandle): Promise<void> {
  return syncThenCatchUp(h, () => loadStore().foods);
}

/** Starts sync for `h`. Returns the stop that removes every listener and timer. */
export function startAccountSync(h: AccountHandle, deps: AccountSyncDeps = {}): () => void {
  const win = deps.win ?? window;
  const doc = win.document;
  const pass = deps.run ?? defaultRun;
  const flushUndos = deps.flushUndos ?? ((handle: AccountHandle) => flushPendingUndos(handle));
  let stopped = false;
  let timer: number | null = null;
  const run = (): void => {
    if (stopped) return;
    // A rejection is offline, signed out, or the account changed; the outbox keeps the write and
    // backs off on its own.
    void pass(h).catch(() => {})
      .then(() => (stopped ? undefined : flushUndos(h)))
      .catch(() => {}); // Queued records stay queued; the next pass sends them.
  };

  // The feed cursor may already have consumed the cached plan: recover this account's rows.
  void restoreCachedPlanDays(h).then((count) => {
    if (count && !stopped) win.dispatchEvent(new Event(SYNCED_EVENT));
  }).catch(() => {}); // A blocked cache does not prevent the normal network sync.

  // t24b: a revision dated for a new local day becomes current without a write or a network pass.
  const roll = deps.rollTargetDay ?? targetDayRoll(h);
  let midnight: number | null = null;
  const rollDay = (): void => {
    if (!stopped && roll()) win.dispatchEvent(new Event(SYNCED_EVENT));
  };
  const armMidnight = (): void => {
    midnight = win.setTimeout(() => { rollDay(); armMidnight(); }, msUntilNextLocalDay());
  };
  rollDay();
  armMidnight();

  run();
  // T0 §5: the hot routes are warmed on the way in.
  void pingWarm();

  const onVisible = (): void => {
    if (doc.visibilityState !== "visible") return;
    rollDay();
    void pingWarm();
    run();
  };
  const onOnline = (): void => run();
  const scheduleRun = (): void => {
    if (timer) win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      timer = null;
      run();
    }, SAVE_DEBOUNCE_MS);
  };
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("online", onOnline);
  win.addEventListener(OUTBOX_QUEUED_EVENT, scheduleRun);
  setOnSave(scheduleRun);
  // A meal-time or shift edit, from any writer, goes to user_settings (Phase 17 O4a). Edits queue
  // one after another, so the last one wins; a failure (the account changed) leaves the phone's own
  // schedule as it is.
  const queueSchedule = deps.queueSchedule ?? queueScheduleEdit;
  let scheduleChain: Promise<void> = Promise.resolve();
  setOnScheduleEdit((owner, settings) => {
    if (stopped || owner.userId !== h.userId) return;
    scheduleChain = scheduleChain.then(() => queueSchedule(h, settings)).catch(() => {});
  });

  return () => {
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("online", onOnline);
    win.removeEventListener(OUTBOX_QUEUED_EVENT, scheduleRun);
    if (timer) win.clearTimeout(timer);
    if (midnight) win.clearTimeout(midnight);
    setOnSave(null);
    setOnScheduleEdit(null);
  };
}

/** The ready/gone subscription `SyncBootstrap` mounts: one running sync, for the ready account. */
export function mountAccountSync(start: typeof startAccountSync = startAccountSync): () => void {
  let stop: (() => void) | null = null;
  const offReady = onAccountReady((h) => { stop?.(); stop = start(h); });
  const offGone = onAccountGone(() => { stop?.(); stop = null; });
  return () => { offReady(); offGone(); stop?.(); stop = null; };
}
