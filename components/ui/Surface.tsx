import type { ReactNode } from "react";

/**
 * The one card (DESIGN.md §Elevation & Depth, KIT.md §6). `card` is the ivory face in its shell:
 * E1 on the ground, carrying `--shadow-card`. Inside another card pass `nested`: the inset step at
 * E0 (one shade down, a 12 % hairline, no drop), because a shadow never sits inside a shadow and a
 * card must differ from the card behind it (DESIGN.md §Elevation, the contrast step). New cards use
 * `CardFrame`, which picks the step itself. `panel` is the section-hue
 * wash; `sheet` the pop-up face. Padding is the caller's: pass it in `className`.
 */
export default function Surface({ variant = "card", nested = false, className = "", children }: {
  variant?: "card" | "panel" | "sheet";
  /** A card inside a card: the inset step, E0, no drop shadow. */
  nested?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (variant === "card") {
    if (nested) return <div className={`surface card-recess ${className}`.trim()}>{children}</div>;
    return (
      <div className="shell w-full">
        <div className={`surface ${className}`.trim()}>{children}</div>
      </div>
    );
  }
  const recipe = variant === "panel" ? "olive-panel" : "sheet-surface";
  return <div className={`${recipe} ${className}`.trim()}>{children}</div>;
}
