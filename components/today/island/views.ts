import type { WidgetPanel } from "@/lib/today/widget-prefs";

/**
 * What the open well shows (owner, 2026-10-06: "this whole square is for an amazing visualization";
 * "if somebody wants to just look at their calories, it can be in the small bubble"). Open, the
 * calorie and macro panels are one showcase: the calories on top and the three macro rings below. A
 * saved order that names two of them shows that showcase once.
 */
export type WellView = "fuel" | "pond" | "water" | "rebalance";

export const VIEW_OF: Record<WidgetPanel, WellView> = {
  kcalLeft: "fuel",
  kcalEaten: "fuel",
  macros: "fuel",
  // Owner, 2026-10-07: the rings became the pond scene, its rainbow the day's four measures.
  rings: "pond",
  macroRings: "pond",
  water: "water",
  rebalance: "rebalance",
};

export const VIEW_NAME: Record<WellView, string> = {
  fuel: "Calories, protein, carbs and fat",
  pond: "Sprout's pond",
  water: "Water",
  rebalance: "Rebalance my day",
};

/** The open well's views in the saved order, each once. */
export function wellViews(panels: readonly WidgetPanel[]): WellView[] {
  return [...new Set(panels.map((panel) => VIEW_OF[panel]))];
}

/** The first saved panel that opens to this view. */
export function panelForView(panels: readonly WidgetPanel[], view: WellView): number {
  return panels.findIndex((panel) => VIEW_OF[panel] === view);
}
