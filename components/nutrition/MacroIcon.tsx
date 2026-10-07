import { Apple, EggFried, Wheat } from "lucide-react";
import type { SVGProps } from "react";
import { MACRO_SPEC, type MacroKey } from "@/components/nutrition/spec";

/** Fat: an avocado half with its stone, drawn in the same line as the lucide set. */
function Avocado({ size, strokeWidth, ...rest }: SVGProps<SVGSVGElement> & { size: number; strokeWidth: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" {...rest}>
    <path d="M12 2.5c-2.6 0-4.2 2.6-4.6 5.4-.3 2-2.4 3.4-2.9 6.1C3.7 18.2 7.1 21.5 12 21.5s8.3-3.3 7.5-7.5c-.5-2.7-2.6-4.1-2.9-6.1C16.2 5.1 14.6 2.5 12 2.5Z" />
    <circle cx="12" cy="14.5" r="3" />
  </svg>;
}

const ICONS = { kcal: Apple, protein: EggFried, carbs: Wheat } as const;

/**
 * A nutrient as an icon (DESIGN.md: linear, 1.5 px, currentColor): the orbit's food forms in line —
 * an apple for calories, a fried egg for protein, wheat for carbs, an avocado for fat — in the
 * nutrient's ink. Decorative by default; pass `label` when the icon stands alone.
 */
export default function MacroIcon({ macro, size = 16, label, className = "" }: {
  macro: MacroKey; size?: number; label?: string; className?: string;
}) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  const cls = `shrink-0 ${MACRO_SPEC[macro].ink} ${className}`.trim();
  if (macro === "fat") return <Avocado size={size} strokeWidth={1.5} className={cls} {...a11y} />;
  const Icon = ICONS[macro];
  return <Icon size={size} strokeWidth={1.5} className={cls} {...a11y} />;
}
