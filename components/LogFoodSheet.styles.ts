/**
 * The sheet's own inline recipes, copied from LogMeal.dc.html: the `.row` list row (16 px radius),
 * the two source badges and the three text sizes. Wells and pills
 * come from globals.css, and every colour here is already in the NeuForm contract (DESIGN.md).
 *
 * Its own file so components/LogFoodSheet.tsx stays under the 800-line hard max (Grok pass 4,
 * LOW 6). Nothing here renders anything; it is a style sheet that happens to be TypeScript.
 *
 * Font size/weight/tracking and colour are design-system utilities (ROW_*_CLASS, BADGE_*_CLASS
 * below), never a CSSProperties value — tests/design/inline-style.test.ts checks
 * every CSSProperties-typed constant in this file, not only what components/LogFoodSheet.tsx does
 * with it. The STYLE objects below hold only what has no utility: a gradient background or a
 * recipe box-shadow.
 */

/* A row inside the sheet is E0 (2026-10-04, DESIGN.md §Elevation): the sheet is already lifted, and a
   shadow never sits inside a shadow. The buttons are `components/ui/Button`. */
export const ROW_STYLE: React.CSSProperties = {
  background: "var(--grad-card)",
};
export const ROW_CLASS = "rounded-2xl elev-0";

export const BADGE_USDA_STYLE: React.CSSProperties = {
  background: "var(--grad-ink)",
  boxShadow: "inset 0 1px 1px rgba(255,255,255,0.2)",
};
export const BADGE_USDA_CLASS = "h-9 w-9 rounded-xl text-on-primary text-tiny font-normal tracking-wider";

export const BADGE_MINE_STYLE: React.CSSProperties = {
  ...BADGE_USDA_STYLE,
  background: "var(--grad-card)",
  boxShadow: "inset 0 1px 2px var(--highlight), 0 0 0 1px rgb(var(--ink-rgb) / 0.10)",
};
export const BADGE_MINE_CLASS = "h-9 w-9 rounded-xl text-graphite text-tiny font-normal tracking-wider";

export const ROW_TITLE_CLASS = "text-caption font-normal";
export const ROW_META_CLASS = "text-tiny font-light text-muted";
export const SECTION_LABEL_CLASS = "text-tiny font-normal text-graphite";
