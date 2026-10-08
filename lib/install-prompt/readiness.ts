import type { Store } from "@/lib/types";

/** Durable across sessions: how many times the app has been opened on this device. */
export const OPEN_COUNT_KEY = "meal-companion:install-prompt-opens";
/** When the most recently counted open happened (epoch ms). */
const LAST_OPEN_AT_KEY = "meal-companion:install-prompt-last-open-at";
/** A reopen at least this long after the last one counts as a new open even on the same day. */
const OPEN_GAP_MS = 30 * 60 * 1000;

/** How long a declined Android install prompt stays quiet. */
export const ANDROID_DECLINE_COOLDOWN_DAYS = 7;
const ANDROID_DECLINED_AT_KEY = "meal-companion:install-prompt-android-declined-at";
const ANDROID_DECLINED_MEAL_COUNT_KEY = "meal-companion:install-prompt-android-declined-meals";

type ReadWrite = Pick<Storage, "getItem" | "setItem">;
type Read = Pick<Storage, "getItem">;

function toCount(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toTimestamp(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isSameCalendarDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/**
 * Counts app opens in durable storage — never a per-tab guard, which never counted a retained
 * Safari tab that was simply reloaded or reopened (Sol review, 2026-10-08). A new open is a
 * different calendar day from the last recorded one, or at least `OPEN_GAP_MS` since it, whichever
 * comes first; this is only the fallback "meaningful moment" for an account that has not logged a
 * meal yet — see `meaningfulMomentReached`. Never throws: a storage failure (private browsing,
 * quota, disabled storage) answers the best count already known, or zero.
 */
export function recordAppOpen(storage: ReadWrite, now: number = Date.now()): number {
  try {
    const current = toCount(storage.getItem(OPEN_COUNT_KEY));
    const last = toTimestamp(storage.getItem(LAST_OPEN_AT_KEY));
    const isNewOpen = last === null || !isSameCalendarDay(last, now) || now - last >= OPEN_GAP_MS;
    const next = isNewOpen ? current + 1 : current;
    if (isNewOpen) {
      // Only a counted open moves the reference point — otherwise a stream of reloads inside the
      // gap would keep resetting their own clock and never cross it.
      storage.setItem(OPEN_COUNT_KEY, String(next));
      storage.setItem(LAST_OPEN_AT_KEY, String(now));
    }
    return next;
  } catch {
    return 0;
  }
}

/** Reads the durable open count without recording anything. */
export function readOpenCount(storage: Read): number {
  try {
    return toCount(storage.getItem(OPEN_COUNT_KEY));
  } catch {
    return 0;
  }
}

/** Module-level, not component state: survives every remount within one page load, and is the
 *  single source of truth for "has this load already recorded its open" — see `recordPageOpenOnce`. */
let recordedThisLoad = false;
/** When the page was last hidden (epoch ms), or null while visible / never hidden yet. */
let hiddenAt: number | null = null;

/**
 * Records exactly one open per page load (Sol review, 2026-10-08, BLOCK: the effect that called
 * `recordAppOpen` reran on every prop change — a Today page left open across a clock tick, with a
 * new `store` reference each minute, was counting itself as a second open with nothing re-opened
 * at all). Guarded by a module-level flag, not a ref or state, so it survives every remount of the
 * component within this one page load and still resets on an actual full reload (a fresh module
 * instance). Returns `null` on every call after the first — the caller already has the count from
 * its first call, or can read it fresh with `readOpenCount` after a remount.
 */
export function recordPageOpenOnce(storage: ReadWrite, now: number = Date.now()): number | null {
  if (recordedThisLoad) return null;
  recordedThisLoad = true;
  return recordAppOpen(storage, now);
}

/** Call when the page becomes hidden (`document.visibilityState === "hidden"`). */
export function noteVisibilityHidden(now: number = Date.now()): void {
  hiddenAt = now;
}

/**
 * Call when the page becomes visible again. Counts a new open — through the same durable,
 * day-or-gap `recordAppOpen` — only when the page was hidden for at least `OPEN_GAP_MS`; a quick
 * tab-switch answers `null` and counts nothing. Never on a bare re-render: nothing calls this
 * except the `visibilitychange` listener itself.
 */
export function noteVisibilityVisible(storage: ReadWrite, now: number = Date.now()): number | null {
  const since = hiddenAt;
  hiddenAt = null;
  if (since === null || now - since < OPEN_GAP_MS) return null;
  return recordAppOpen(storage, now);
}

/** Test-only: resets the module-level open-tracking state between specs. */
export function __resetPageOpenTrackingForTests(): void {
  recordedThisLoad = false;
  hiddenAt = null;
}

/** Pure: has this account ever logged (eaten or extra) a meal, on any stored day? */
export function hasLoggedAnyMeal(store: Pick<Store, "days">): boolean {
  return Object.values(store.days ?? {}).some((day) =>
    (day.extras?.length ?? 0) > 0 || Object.keys(day.eaten ?? {}).length > 0);
}

/** Pure: the total count of logged (eaten or extra) meals across every stored day. Used only to
 *  tell whether a NEW meal was logged after a declined Android prompt — see `androidPromptOnCooldown`. */
export function loggedMealCount(store: Pick<Store, "days">): number {
  return Object.values(store.days ?? {}).reduce((total, day) =>
    total + Object.keys(day.eaten ?? {}).length + (day.extras?.length ?? 0), 0);
}

/**
 * The install hint never overlays onboarding's first moments (owner feedback, 2026-10-08): it
 * waits for a logged meal, and only falls back to "the second time the app was opened" for an
 * account that has not logged one yet.
 */
export function meaningfulMomentReached(store: Pick<Store, "days">, opens: number): boolean {
  return hasLoggedAnyMeal(store) || opens >= 2;
}

/**
 * A declined (not dismissed-by-the-user) Android install prompt is not suppressed forever (Sol
 * review, 2026-10-08, WARN): record when it happened and how many meals were logged by then.
 * Never throws.
 */
export function recordAndroidPromptDeclined(
  storage: ReadWrite,
  store: Pick<Store, "days">,
  now: number = Date.now(),
): void {
  try {
    storage.setItem(ANDROID_DECLINED_AT_KEY, String(now));
    storage.setItem(ANDROID_DECLINED_MEAL_COUNT_KEY, String(loggedMealCount(store)));
  } catch {
    // Private browsing / storage disabled — the prompt just reappears sooner, which is harmless.
  }
}

/**
 * True while a declined Android prompt should stay quiet: within `ANDROID_DECLINE_COOLDOWN_DAYS`
 * of the decline AND no meal has been logged since. Either condition clearing re-allows the
 * prompt. Never throws (a storage failure answers "not on cooldown", i.e. safe to show).
 */
export function androidPromptOnCooldown(
  storage: Read,
  store: Pick<Store, "days">,
  now: number = Date.now(),
): boolean {
  try {
    const declinedAt = toTimestamp(storage.getItem(ANDROID_DECLINED_AT_KEY));
    if (declinedAt === null) return false;
    const countAtDecline = toCount(storage.getItem(ANDROID_DECLINED_MEAL_COUNT_KEY));
    if (loggedMealCount(store) > countAtDecline) return false;
    return now - declinedAt < ANDROID_DECLINE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}
