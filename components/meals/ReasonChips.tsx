import Tag from "@/components/ui/Tag";
import { REASON_CHIP_COPY, shownReasonChips } from "@/lib/meals/reason-chips";

/**
 * Why a generated meal, swap row or composed card was offered (W099): "You eat this often",
 * "Favorite". Text only, never a control and never a verdict; renders nothing without a reason.
 */
export default function ReasonChips({ reasons, size = "sm", className = "" }:
  { reasons?: readonly unknown[] | null; size?: "sm" | "md"; className?: string }) {
  const chips = shownReasonChips(reasons);
  if (chips.length === 0) return null;
  return <span data-reason-chips="" className={`inline-flex min-w-0 flex-wrap items-center gap-1 ${className}`.trim()}>
    {chips.map((chip) => <Tag key={chip} tone="sage" size={size}>{REASON_CHIP_COPY[chip]}</Tag>)}
  </span>;
}
