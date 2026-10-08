"use client";

import type { Macros } from "@/lib/types";
import dark from "./AfterDarkCards.module.css";

const MACROS = [
  { key: "protein", letter: "P", dot: dark.dotProtein },
  { key: "carbs", letter: "C", dot: dark.dotCarbs },
  { key: "fat", letter: "F", dot: dark.dotFat },
] as const;

/**
 * The compact header's figure line beside the calories (meal cards v3). Collapsed, protein alone —
 * the macro the plan protects. Open, all three inline (P · C · F), so the big spec panel can stay
 * folded and the ingredients sit near the top. Dots are the gauge colours; the words stay cream.
 */
export default function MealFigureLine({ macros, full }: { macros: Macros; full: boolean }) {
  if (!full) return <span data-compact-protein="" className={dark.protein}>
    <span aria-hidden="true" className={dark.dotProtein} />{Math.round(macros.protein)} g protein
  </span>;
  return <span data-compact-macros="" className={dark.protein}>
    {MACROS.map(({ key, letter, dot }, index) => <span key={key} className={dark.macroItem}>
      {index > 0 && " "}<span aria-hidden="true" className={dot} />{letter} {Math.round(macros[key])}g
    </span>)}
  </span>;
}
