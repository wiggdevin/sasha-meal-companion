/**
 * The one sentence builder for a rule mark: the food's name, then the server's reason fragment
 * ("has peanut, which your rules exclude."). Pure and dependency-free so the server
 * (`/api/foods/eligible`) and the phone (`lib/foods/rule-marks.ts`) build the same words.
 */
import type { RuleMark } from "@/lib/types";

/** "Banana has peanut, which your rules exclude." — a blank name reads as `fallback`. */
export function namedRuleMark(name: string, mark: RuleMark, fallback = "This food"): RuleMark {
  return { verdict: mark.verdict, reason: `${name.trim() || fallback} ${mark.reason.trim()}` };
}
