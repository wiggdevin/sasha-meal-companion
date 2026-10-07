/**
 * The one definition of how a nutrient is named and coloured (owner, 2026-10-04: "standardize the way
 * we show calories and macros"). Every nutrition component reads this table, so a macro looks the same
 * as text, as an icon and in a graph: calories persimmon, protein plum, carbs sage, fat Dijon.
 *
 * - `ink`: the readable text shade on light surfaces (DESIGN.md §Contrast); `.kcal` for calories.
 *   Icons take the ink too, so they keep 3:1 on ivory.
 * - `fill`: the gauge hue for fills (bars, dots). Arcs use `fill` with `stroke-current`.
 * - `abbr`: the three-letter label for tight rows (PRO, CAR, FAT); `letter` for the tightest.
 */
export const MACROS = ["kcal", "protein", "carbs", "fat"] as const;
export type MacroKey = (typeof MACROS)[number];
export type GramMacro = Exclude<MacroKey, "kcal">;
export const GRAM_MACROS: readonly GramMacro[] = ["protein", "carbs", "fat"];

export type MacroSpec = {
  label: string;
  abbr: string;
  letter: string;
  unit: "kcal" | "g";
  ink: string;
  fill: string;
  /** Energy per gram, for a macro's share of calories. */
  kcalPerGram: number | null;
};

export const MACRO_SPEC: Record<MacroKey, MacroSpec> = {
  kcal: { label: "Calories", abbr: "kcal", letter: "K", unit: "kcal", ink: "kcal", fill: "macro-kcal", kcalPerGram: null },
  protein: { label: "Protein", abbr: "PRO", letter: "P", unit: "g", ink: "macro-ink-protein", fill: "macro-protein", kcalPerGram: 4 },
  carbs: { label: "Carbs", abbr: "CAR", letter: "C", unit: "g", ink: "macro-ink-carbs", fill: "macro-carbs", kcalPerGram: 4 },
  fat: { label: "Fat", abbr: "FAT", letter: "F", unit: "g", ink: "macro-ink-fat", fill: "macro-fat", kcalPerGram: 9 },
};

/** A serving's or a day's four values; null where a value is unknown (never shown as 0). */
export type MacroValues = Record<MacroKey, number | null>;

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** "508", "1,891": whole numbers with grouping, the only way figures are written. */
export function formatMacro(value: number): string {
  return whole(value);
}

/** Each gram macro's share of the calories its grams carry (protein 4, carbs 4, fat 9 kcal/g), from
 *  the grams themselves so the three shares always add to 1. Null unless all three are known: a split
 *  that read a missing value as 0 would overstate the others. */
export function energySplit(values: MacroValues): Record<GramMacro, number> | null {
  if (GRAM_MACROS.some((key) => values[key] === null)) return null;
  const energy = GRAM_MACROS.map((key) => values[key]! * MACRO_SPEC[key].kcalPerGram!);
  const total = energy.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return { protein: energy[0] / total, carbs: energy[1] / total, fat: energy[2] / total };
}

/** The spoken form of one value: "51 grams protein", "508 calories". */
export function spokenMacro(key: MacroKey, value: number | null): string {
  if (value === null) return `${MACRO_SPEC[key].label} unknown`;
  return key === "kcal" ? `${whole(value)} calories` : `${whole(value)} grams ${MACRO_SPEC[key].label.toLowerCase()}`;
}
