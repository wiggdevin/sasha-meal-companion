/**
 * W047 (d): the next instant a confirmed hard rule can change its verdict on its own, with no
 * write and so no move of the rules token: a calendar window opening or closing, or an expiry.
 * The phone's eligible cache is never used at or after it (`GET /api/foods/rules-version`
 * `ruleBoundaryAt`). Pure: no I/O.
 *
 * Every candidate a rule could flip on is counted, the same items `isActiveHardRule` can make
 * active (strength "never", a hard basis, confirmed), whatever their state now. A date that does
 * not parse answers `undefined`, which the route sends as no `ruleBoundaryAt` (no cache): the
 * cache is never trusted around a rule it cannot read.
 */
import type { ProfileInstance } from "@/lib/policy/profiles/types";

export function nextRuleBoundary(instances: readonly ProfileInstance[], now: Date): Date | null | undefined {
  const t = now.getTime();
  let next: number | null = null;
  let unreadable = false;
  const consider = (iso: string): void => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) { unreadable = true; return; }
    if (at > t && (next === null || at < next)) next = at;
  };
  for (const instance of instances) {
    for (const item of instance.rules) {
      if (item.strength !== "never" || item.hardBasis === null || item.confirmation !== "confirmed") continue;
      if (item.expiresAt !== null) consider(item.expiresAt);
      if (item.window === "calendar") {
        for (const window of item.activeWindows ?? []) {
          consider(window.start);
          consider(window.end);
        }
      }
    }
  }
  if (unreadable) return undefined;
  return next === null ? null : new Date(next);
}
