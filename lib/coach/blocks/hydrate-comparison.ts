import { uiBlockV1Schema, type UiBlockV1 } from "@/lib/coach/ui-blocks";

type Totals = { kcal: number; protein: number; carbs: number; fat: number };

/**
 * The "compare these options" card, drawn in code from the macros the tool loop already fetched
 * this turn (`compose_meal` / `suggest_options`, `lib/coach/compose.ts` `ComposedMeal`). Two or
 * more options make a comparison; fewer yield no block. At most four options are shown, labelled
 * "Option 1", "Option 2", … — never the user's wish text or a food name.
 *
 * `null` when there is nothing to compare or the card would not pass `uiBlockV1Schema`.
 */
export function hydrateComparison(
  id: string, composed: readonly { totals: Totals }[],
): UiBlockV1 | null {
  if (composed.length < 2) return null;
  const children = composed.slice(0, 4).flatMap(({ totals }, index) => [
    { type: "text" as const, variant: "eyebrow" as const, text: `Option ${index + 1}` },
    { type: "metric_row" as const, items: [
      { label: "kcal", value: `${Math.round(totals.kcal)}` },
      { label: "protein", value: `${Math.round(totals.protein)}g` },
      { label: "carbs", value: `${Math.round(totals.carbs)}g` },
      { label: "fat", value: `${Math.round(totals.fat)}g` },
    ] },
  ]);
  const parsed = uiBlockV1Schema.safeParse(
    { kind: "ui", v: 1, id, root: { type: "card", title: "Compare", children } });
  return parsed.success ? parsed.data : null;
}
