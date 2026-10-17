import type { ReactNode } from "react";
import type { CaptureMethod } from "@/lib/capture/flags";

/* Method glyphs: 1.5 px linear SVG, copied from LogMeal.dc.html's four capture pills.
   DESIGN.md Iconography — never emoji. Kept out of CaptureSheet (W139) so Today's logged rows
   draw a glyph without pulling the capture sheet into their bundle. */
const GLYPH_PATHS: Record<CaptureMethod, ReactNode> = {
  text: (<><path d="M4 7h16" /><path d="M4 12h10" /><path d="M4 17h7" /></>),
  voice: (<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>),
  label: (<><path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M8 9v6" /><path d="M12 9v6" /><path d="M16 9v6" /></>),
  photo: (<><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="12.5" r="3.5" /></>),
};

export function CaptureGlyph({ method, size = 18 }: { method: CaptureMethod; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {GLYPH_PATHS[method]}
    </svg>
  );
}
