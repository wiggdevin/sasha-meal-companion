/**
 * The phone's target cache across local midnight (t24b). The current cache is the revision in
 * force on the device's local day (lib/targets/revision.ts). Before this, it was re-resolved only
 * by a write or a sync pass, so a revision dated tomorrow stayed waiting in the history after
 * midnight until something wrote — and offline, nothing did.
 *
 * `targetDayRoll` re-resolves the cache from the history the phone already holds, with no network
 * and no new revision: on its first call, then only when the local day has changed since the last
 * call. `lib/sync/account-sync.ts` calls it on start, on every return to the tab and at local
 * midnight while the tab stays open.
 */
import type { AccountHandle } from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import type { Settings, Store } from "@/lib/types";
import { settingsWithTargetRevisions, targetDayFor } from "@/lib/targets/revision";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function hasDatedRevision(settings: Settings): boolean {
  const current = settings.activeTargetProfile;
  return (settings.targetHistory?.length ?? 0) > 0
    || (!!current && typeof current.revision === "number"
      && typeof current.effectiveFrom === "string" && ISO_DAY.test(current.effectiveFrom));
}

/**
 * `settings` with the revision in force on `today` as the current cache, by the one selection
 * rule. Returns `settings` itself when nothing changes, when the cache is an unsaved onboarding
 * candidate (no revision number: the user's preview), or when nothing dated is held (a legacy
 * cache stays as it is, as `targetRevisionOn` keeps it).
 */
export function settingsForTargetDay(settings: Settings, today: string): Settings {
  const cached = settings.activeTargetProfile;
  if (cached && typeof cached.revision !== "number") return settings;
  if (!hasDatedRevision(settings)) return settings;
  return settingsWithTargetRevisions(settings, [], today);
}

export type TargetDayRollDeps = {
  now?: () => Date;
  load?: () => Store;
  save?: (h: AccountHandle, store: Store, opts: { silent: boolean }) => void;
};

/** One re-resolution for `today`. A silent save (no sync pass is queued for it). True when the
 *  cache changed. An account that changed meanwhile is left alone. */
export function refreshTargetDay(
  h: AccountHandle, today: string = targetDayFor(), deps: TargetDayRollDeps = {},
): boolean {
  const store = (deps.load ?? loadStore)();
  const settings = settingsForTargetDay(store.settings, today);
  if (settings === store.settings) return false;
  try {
    (deps.save ?? saveStoreFor)(h, { ...store, settings }, { silent: true });
    return true;
  } catch {
    return false;
  }
}

/** A roll for one account: the first call re-resolves, later calls only on a new local day. */
export function targetDayRoll(
  h: AccountHandle, deps: TargetDayRollDeps = {},
): () => boolean {
  const now = deps.now ?? (() => new Date());
  let lastDay: string | null = null;
  return () => {
    const today = targetDayFor(now());
    if (today === lastDay) return false;
    lastDay = today;
    return refreshTargetDay(h, today, deps);
  };
}

/** Milliseconds from `now` to just after the next local midnight (DST-safe: built from the local
 *  calendar, not a 24 h step). */
export function msUntilNextLocalDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}
