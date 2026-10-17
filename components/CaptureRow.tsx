"use client";

import { CaptureGlyph } from "@/components/CaptureGlyph";
import { SHORT_CAPTURE_LABELS, type CaptureAction } from "@/lib/capture-client";
import type { CaptureMethod } from "@/lib/capture/flags";

/* 11 px label over a 16 px glyph in a pill that never drops under 44 px — the row
   LogMeal.dc.html draws, as a real control. The drawn word is short (Say or type / Speak / Label /
   Photo) so 3-5 pills neither wrap nor drop below the target; the full line ("Photograph the
   plate") is the button's accessible name. `pill`/`pill-in` come from globals.css; the ink is
   the grey the row always used. */
const INK = "text-graphite";
const ROW_BUTTON = "pill flex-1";
const LABEL = "text-tiny font-normal leading-[1.15] text-graphite";
const ROW_INNER = "pill-in flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 py-2";

export type CaptureRowProps = {
  /** `captureActions()` — one entry per method the flags enable. Empty today, on purpose. */
  actions: CaptureAction[];
  onCapture: (method: CaptureMethod) => void;
  /** Present only when NEXT_PUBLIC_FEATURE_SCAN=1 — `captureOverlayProps` decides, as before. */
  scan?: () => void;
};

/**
 * The capture flow mounts its own Sheet, so the sheet offering this row has to be gone first —
 * close, then open, never both at once. Pure and exported so the order is testable without a tap.
 */
export function closeThenCapture(
  close: () => void,
  capture: (method: CaptureMethod) => void,
): (method: CaptureMethod) => void {
  return (method) => {
    close();
    capture(method);
  };
}

/* Barcode corners + bars — the glyph QuickActions' "Scan a barcode" row uses. */
function BarcodeIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 9v6" />
      <path d="M12 9v6" />
      <path d="M16 9v6" />
    </svg>
  );
}

/**
 * Say or type / Speak / Label / Photo, plus the optional barcode row (flag order first, barcode last —
 * T2 decision 1). One live button per enabled method; with nothing enabled and no scanner the row
 * is not drawn at all, because four buttons that take no interaction is worse than no row.
 */
export default function CaptureRow({ actions, onCapture, scan }: CaptureRowProps) {
  if (actions.length === 0 && !scan) return null;
  return (
    <div className="flex gap-2">
      {actions.map((action) => (
        <button
          key={action.method}
          type="button"
          onClick={() => onCapture(action.method)}
          aria-label={action.label}
          className={`${ROW_BUTTON} ${INK}`}
        >
          <span className={ROW_INNER}>
            {/* "Say or type" leads with the mic: its box always dictates (DictateMic). */}
            <CaptureGlyph method={action.method === "text" ? "voice" : action.method} size={16} />
            <span className={`w-full text-center ${LABEL}`}>
              {SHORT_CAPTURE_LABELS[action.method]}
            </span>
          </span>
        </button>
      ))}
      {scan && (
        <button type="button" onClick={scan} className={`${ROW_BUTTON} ${INK}`}>
          <span className={ROW_INNER}>
            <BarcodeIcon />
            <span className={`w-full text-center ${LABEL}`}>
              Scan
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
