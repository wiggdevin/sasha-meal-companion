import Tag from "@/components/ui/Tag";
import { RULE_MARK_LABEL, ruleMarkReason } from "@/lib/rule-mark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";

export { RULE_MARK_LABEL };


/**
 * How anything saved is marked against the account's current food rules (2026-10-05): shopping lines
 * and pantry items, saved meal slots and their ingredients, accepted recipes. The server's `reason`
 * is a ready sentence ("Peanut butter has peanut, which your rules exclude."); it is never rewritten.
 * A mark never hides or removes the thing it marks: logging marks, it never refuses.
 *
 * - `variant="tag"`: the tag alone, for a tight row; the reason is its accessible description and
 *   its title.
 * - `variant="line"` (default): the tag with the reason beside it, wrapping under a row's main line.
 *
 * Red for blocked, yellow for unknown (DESIGN.md §Colors), through `Tag` only. Renders nothing for
 * a null or missing mark, so callers can pass the field as it arrives.
 */
export default function RuleMark({ mark, variant = "line", className = "" }: {
  mark: RuleMarkValue | null | undefined; variant?: "line" | "tag"; className?: string;
}) {
  if (!mark) return null;
  // A reason that starts with a food's own name can arrive lowercase ("whey protein powder is…").
  const reason = ruleMarkReason(mark);
  const tone = mark.verdict === "blocked" ? "red" : "yellow";
  const label = RULE_MARK_LABEL[mark.verdict];
  if (variant === "tag") {
    return <Tag tone={tone} title={reason} className={className} data-rule-mark={mark.verdict}>
      {label}<span className="sr-only">: {reason}</span>
    </Tag>;
  }
  return <span className={`flex min-w-0 items-start gap-2 ${className}`.trim()} data-rule-mark={mark.verdict}>
    <Tag tone={tone}>{label}</Tag>
    <span className="min-w-0 break-words text-caption text-muted">{reason}</span>
  </span>;
}
