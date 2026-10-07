/**
 * One strip day, resolved exactly how Today would via the one builder (lib/today/resolve-inputs.ts).
 * Its own module so both the calendar strip (components/TodayDayStrip.tsx) and its status-caching
 * hook (components/today/use-strip-statuses.ts) can call it without the hook importing the
 * component it backs.
 */
import { resolveDay } from "@/lib/resolve";
import { todayResolveInputs, type TodayLive } from "@/lib/today/resolve-inputs";
import type { Store } from "@/lib/types";

/**
 * Without `live` (an unwired caller, or a test) the day resolves as stored, matching the strip's
 * original, unprojected resolve.
 */
export function resolveStripDay(store: Store, date: string, live?: TodayLive) {
  return resolveDay(...todayResolveInputs(store, date, live ?? {
    accepted: null, recipeAccessEnabled: false, ruleReviewReady: store.settings.ruleReviewReady === true,
  }).args);
}
