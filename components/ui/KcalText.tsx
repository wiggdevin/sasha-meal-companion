/**
 * A line that holds calorie figures ("537 kcal · 40P 52C 18F"), with every number that comes before
 * "kcal" set in the shared calorie colour (DESIGN.md §Colors, owner 2026-10-03: calories are
 * persimmon everywhere, a little bolder). The unit and the rest of the line keep the line's own
 * colour, so "kcal" stays muted.
 */
const KCAL_FIGURE = /(\d[\d,.]*)(?=\s*kcal\b)/g;

export default function KcalText({ text }: { text: string }) {
  const parts = text.split(KCAL_FIGURE);
  // split() with one capture group alternates: plain text at even indexes, figures at odd ones.
  return <>{parts.map((part, index) => index % 2 === 1
    ? <span key={index} className="kcal font-semibold tabular-nums">{part}</span>
    : part)}</>;
}
