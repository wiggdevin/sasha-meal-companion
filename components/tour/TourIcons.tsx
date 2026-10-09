/**
 * The meal card's strip icons as the overview draws them (meal-cards-v3: Mark eaten is an empty check
 * that fills when eaten, Swap, Expand a chevron; a heart saves a favorite meal). Line glyphs at
 * 1.75 px like the app's own, decorative: the words beside them carry the meaning.
 */
export type TourIconName = "check" | "checked" | "swap" | "expand" | "heart" | "hearted";

export function TourIcon({ name, size = 18 }: { name: TourIconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "check") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.7L16 9.5" /></svg>;
  if (name === "checked") return <svg {...common}><circle cx="12" cy="12" r="9" fill="currentColor" />
    <path d="m8 12.5 2.8 2.7L16 9.5" stroke="var(--color-on-primary)" strokeWidth={2.25} /></svg>;
  if (name === "swap") return <svg {...common}><path d="M4 8h13m-4-4 4 4-4 4M20 16H7m4-4-4 4 4 4" /></svg>;
  if (name === "expand") return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
  const heart = "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z";
  return <svg {...common}><path d={heart} fill={name === "hearted" ? "currentColor" : "none"} /></svg>;
}
