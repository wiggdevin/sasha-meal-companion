"use client";

import { accountFetch, accountJson, currentAccountOrNull } from "@/lib/device/account";
import type { DayCompletenessState } from "@/lib/day-completeness";

/**
 * W142: ask whether the viewed day looks short of a meal. Every failure (offline, a slow answer,
 * a signed-out phone, an account change) is false: no nudge, and the mark goes ahead.
 */
export async function fetchDayNudge(state: DayCompletenessState): Promise<boolean> {
  const account = currentAccountOrNull();
  if (!account) return false;
  try {
    const res = await accountFetch(account, "/api/today/day-completeness", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(state),
    }, { budget: "nudge" });
    if (!res.ok) return false;
    const json = await accountJson<{ nudge?: unknown }>(account, res);
    return json.nudge === true;
  } catch {
    return false;
  }
}
