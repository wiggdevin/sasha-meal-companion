import MacroIcon from "@/components/nutrition/MacroIcon";
import { MACRO_SPEC, MACROS, formatMacro, spokenMacro, type MacroKey, type MacroValues } from "@/components/nutrition/spec";
import { boundWords, proteinShortGrams, type Bound } from "@/lib/nutrition-display";

/** How a figure names its nutrient: the three-letter tag (PRO), the word (protein), the letter (P),
 *  the nutrient's icon, or nothing (a column already says it). */
export type MacroLabel = "abbr" | "word" | "letter" | "icon" | "none";

/**
 * One nutrient as text, the standard form (owner, 2026-10-04): the figure bold in the nutrient's ink,
 * its unit tight to it ("51g"), then its label quiet. Calories read "508 kcal" in persimmon. Spoken in
 * full ("51 grams protein") whatever the visible label.
 */
export function MacroFigure({ macro, value, label = "abbr", bound, className = "" }: {
  macro: MacroKey; value: number | null; label?: MacroLabel;
  /** A partial count says so in words before the figure ("at least 508 kcal"), never by hue. */
  bound?: Bound; className?: string;
}) {
  const spec = MACRO_SPEC[macro];
  const unit = macro === "kcal" ? "" : "g";
  const name = macro === "kcal" ? "kcal" : label === "abbr" ? spec.abbr : label === "word" ? spec.label.toLowerCase()
    : label === "letter" ? spec.letter : "";
  const words = value === null ? "" : boundWords(bound);
  return <span className={`inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums ${className}`.trim()}>
    {words && <span className="text-muted" data-bound={bound}>{words}</span>}
    <span className="sr-only">{spokenMacro(macro, value)}</span>
    {label === "icon" && <span aria-hidden="true" className="self-center"><MacroIcon macro={macro} size={14} /></span>}
    <span aria-hidden="true" className={`font-semibold ${value === null ? "text-muted" : spec.ink}`}>
      {value === null ? "—" : `${formatMacro(value)}${unit}`}</span>
    {name && (label !== "icon" || macro === "kcal") && <span aria-hidden="true"
      className={label === "abbr" && macro !== "kcal" ? "text-overline tracking-[0.08em] text-muted" : "text-muted"}>{name}</span>}
  </span>;
}

/** Calories then the three macros on one line, separated by quiet dots: the standard summary of a
 *  food, a meal or a recipe. Wraps only when the row has no room. */
export function MacroLine({ values, label = "abbr", only = MACROS, bound, className = "" }: {
  values: MacroValues; label?: MacroLabel; only?: readonly MacroKey[];
  /** Said once, before the first figure: the whole line is that kind of count. */
  bound?: Bound; className?: string;
}) {
  return <span className={`inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-tiny ${className}`.trim()}>
    {only.map((key, index) => <span key={key} className="inline-flex items-baseline gap-2">
      {index > 0 && <span aria-hidden="true" className="text-text-faint">·</span>}
      <MacroFigure macro={key} value={values[key]} label={label} bound={index === 0 ? bound : undefined} />
    </span>)}
  </span>;
}

/** A shopping choice's protein shortfall: "12g short of protein", the figure in protein's ink.
 *  Nothing for a null, zero or positive gap (lib/nutrition-display.ts `proteinShortGrams`). */
export function ProteinShort({ gap, className = "" }: { gap: number | null | undefined; className?: string }) {
  const grams = proteinShortGrams(gap);
  if (grams === null) return null;
  return <span className={`whitespace-nowrap tabular-nums ${className}`.trim()} data-protein-short="">
    <span className={`font-semibold ${MACRO_SPEC.protein.ink}`}>{formatMacro(grams)}g</span> short of protein
  </span>;
}
