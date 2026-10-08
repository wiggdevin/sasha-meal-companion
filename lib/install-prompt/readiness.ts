import type { Store } from "@/lib/types";

/** Durable across sessions: how many times the app has been opened on this device. */
export const OPEN_COUNT_KEY = "meal-companion:install-prompt-opens";
/** Per-tab guard so one session only ever increments the durable count once. */
const OPEN_MARKED_KEY = "meal-companion:install-prompt-open-marked";

type ReadWrite = Pick<Storage, "getItem" | "setItem">;

function toCount(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Counts app opens, once per tab session (`session` guards the double-count), persisted across
 * sessions in `storage`. This is only the fallback "meaningful moment" for an account that has not
 * logged a meal yet — see `meaningfulMomentReached`.
 */
export function recordAppOpen(storage: ReadWrite, session: ReadWrite): number {
  const current = toCount(storage.getItem(OPEN_COUNT_KEY));
  if (session.getItem(OPEN_MARKED_KEY) === "1") return current;
  session.setItem(OPEN_MARKED_KEY, "1");
  const next = current + 1;
  storage.setItem(OPEN_COUNT_KEY, String(next));
  return next;
}

/** Pure: has this account ever logged (eaten or extra) a meal, on any stored day? */
export function hasLoggedAnyMeal(store: Pick<Store, "days">): boolean {
  return Object.values(store.days ?? {}).some((day) =>
    (day.extras?.length ?? 0) > 0 || Object.keys(day.eaten ?? {}).length > 0);
}

/**
 * The install hint never overlays onboarding's first moments (owner feedback, 2026-10-08): it
 * waits for a logged meal, and only falls back to "the second time the app was opened" for an
 * account that has not logged one yet.
 */
export function meaningfulMomentReached(store: Pick<Store, "days">, opens: number): boolean {
  return hasLoggedAnyMeal(store) || opens >= 2;
}
