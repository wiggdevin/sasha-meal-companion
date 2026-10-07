import type { BoardTip, TipGlyph as TipGlyphName } from "@/lib/today/board";

export type Glyph = TipGlyphName | "tip";

export function glyphOf(tip: BoardTip): Glyph {
  return tip.glyph ?? (tip.source === "coach" ? "coach" : "tip");
}

/** One small line glyph per tip (DESIGN.md §Shapes: linear, 1.5 px, currentColor). Drawn on the
 *  tile at 18 px and in the tip's full view at 22 px. */
export default function TipGlyph({ glyph, size = 18 }: { glyph: Glyph; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (glyph) {
    case "overview": return <svg {...common}>
      <circle cx="12" cy="12" r="3.2" /><ellipse cx="12" cy="12" rx="9.5" ry="4.6" transform="rotate(-24 12 12)" />
      <circle cx="19.6" cy="8.2" r="1.3" fill="currentColor" stroke="none" />
    </svg>;
    case "calendar": return <svg {...common}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="4" /><path d="M3.5 10h17M8 3v4M16 3v4" />
      <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </svg>;
    case "time": return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
    case "gesture": return <svg {...common}>
      <path d="M18.5 12H6" /><path d="m10 7.5-4.5 4.5 4.5 4.5" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>;
    case "water": return <svg {...common}>
      <path d="M12 3.5c3.3 4.1 6 7.4 6 10.5a6 6 0 0 1-12 0c0-3.1 2.7-6.4 6-10.5Z" /><path d="M9.2 14.5a2.9 2.9 0 0 0 2.3 2.6" />
    </svg>;
    case "coach": return <svg {...common}>
      <path d="M5 19c0-8 5.5-13 14-14-.5 8.5-5.5 14-14 14Z" /><path d="M5 19c3-3.5 6-6 9.5-8" />
    </svg>;
    default: return <svg {...common}>
      <path d="M9.5 17.5h5M10.5 20.5h3" />
      <path d="M12 3.5a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3.5Z" />
    </svg>;
  }
}
