import { savePlanDay } from "@/lib/plan-day-client";
import type { StoredDay } from "@/lib/types";

/**
 * Mark `date` fully logged (`true`) or clear the mark (`false`). The mark is the user's statement
 * that every food eaten that day is logged; once an account has marked any day, the expenditure
 * engine counts only marked days (TDEE step E6, ruling R3). It rides the normal `plan_days` op
 * with the omit/keep rule (migration 20261209090100), and the server never sets it.
 */
export function saveDayComplete(date: string, complete: boolean): Promise<StoredDay> {
  return savePlanDay(date, { dayCompleteAt: complete ? new Date().toISOString() : null });
}
