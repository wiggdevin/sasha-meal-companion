import { Leaf, Milk, MilkOff, Sprout, Wheat, WheatOff, type LucideIcon } from "lucide-react";
import MacroIcon from "@/components/nutrition/MacroIcon";
import type { DietFact } from "@/lib/recipes-hub/diet";

const FACTS: Record<DietFact, { label: string; Icon: LucideIcon | null }> = {
  "high-protein": { label: "High protein", Icon: null },
  vegan: { label: "Vegan", Icon: Sprout },
  vegetarian: { label: "Vegetarian", Icon: Leaf },
  "gluten-free": { label: "Gluten-free", Icon: WheatOff },
  "dairy-free": { label: "Dairy-free", Icon: MilkOff },
  "contains-gluten": { label: "Contains gluten", Icon: Wheat },
  "contains-dairy": { label: "Contains dairy", Icon: Milk },
};

/**
 * A diet fact as an icon (owner, 2026-10-04). `icon`: a round fog badge with the glyph alone, named for
 * assistive tech and on hover; `label`: the glyph and its words. High protein wears the protein icon in
 * plum; the others are graphite, so a badge never borrows a macro's hue for something that is not one.
 */
export default function DietBadge({ fact, variant = "label" }: { fact: DietFact; variant?: "icon" | "label" }) {
  const { label, Icon } = FACTS[fact];
  const glyph = Icon ? <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-graphite" />
    : <MacroIcon macro="protein" size={14} />;
  if (variant === "icon") {
    return <span role="img" aria-label={label} title={label} data-diet={fact}
      className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-fog">{glyph}</span>;
  }
  return <span data-diet={fact}
    className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-fog px-2 text-tiny font-medium text-graphite">
    {glyph}{label}</span>;
}
