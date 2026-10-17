import "server-only";

import { dayCompletenessPayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import { DAY_COMPLETENESS_THRESHOLD, type DayCompletenessState } from "@/lib/day-completeness";

const DEADLINE_MS = 2_500;

export type DayCompletenessPort = typeof systemOne;

/**
 * W142: true only when Jev says, above the threshold, that the day's log probably leaves out a
 * meal. Every failure (no key, timeout, the daily cap, a malformed answer) is false: the nudge is
 * advisory and the user's mark never waits on it.
 */
export async function judgeDayCompleteness(
  state: DayCompletenessState, userId: string, port: DayCompletenessPort = systemOne,
): Promise<boolean> {
  try {
    const answers = await port(dayCompletenessPayload(state), { deadlineMs: DEADLINE_MS, userId });
    const probability = answers?.day_incomplete?.noul;
    return typeof probability === "number" && Number.isFinite(probability)
      && probability > DAY_COMPLETENESS_THRESHOLD;
  } catch {
    return false;
  }
}
