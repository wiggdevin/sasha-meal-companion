import type { RuleMark } from "@/lib/types";

/** The words for a rule mark, by verdict: a line the rules exclude, or one the app cannot confirm
 *  yet. One table for the tag (components/ui/RuleMark.tsx) and for text that leaves the app. */
export const RULE_MARK_LABEL: Record<RuleMark["verdict"], string> = {
  blocked: "Off your rules",
  unknown: "Check",
};

/** Same verdict and same reason; missing and null are both "no mark". */
export function sameRuleMark(a: RuleMark | null | undefined, b: RuleMark | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.verdict === b.verdict && a.reason === b.reason;
}

/** A stable text key for a mark, for fingerprints: "" when there is none. */
export function ruleMarkKey(mark: RuleMark | null | undefined): string {
  return mark ? `${mark.verdict}:${mark.reason}` : "";
}

/** The reason as a sentence: one that opens on a food's own name can arrive lowercase ("whey
 *  protein powder is…"); every surface, spoken or copied, starts it with a capital. */
export function ruleMarkReason(mark: RuleMark): string {
  return mark.reason.charAt(0).toUpperCase() + mark.reason.slice(1);
}

/** The more severe of two marks: blocked over unknown over none. */
export function worseRuleMark(a: RuleMark | null | undefined, b: RuleMark | null | undefined): RuleMark | null {
  const rank = (mark: RuleMark | null | undefined) => (!mark ? 0 : mark.verdict === "blocked" ? 2 : 1);
  return rank(b) > rank(a) ? b ?? null : a ?? null;
}
