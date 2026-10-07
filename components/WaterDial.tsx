"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createWaterPress, guardSelection, MAX_CUPS } from "@/lib/today/water-gesture";
import { formatWater, formatWaterOf, stepPhrase, type WaterUnit } from "@/lib/water-units";

/**
 * The water dial's press (2026-09-18). A tap adds one cup. A hold opens a slider over the
 * dial; the finger then drags left or right, one cup per 28 px, and lifting commits. The dial
 * itself (`children`) is drawn by MacroRings; this is the button around it and the slider.
 *
 * Pointer capture keeps the drag on the button when the finger leaves it; `touch-action: pan-y`
 * leaves vertical scrolling to the browser, which cancels the press (pointercancel) — so a scroll
 * that starts on the dial never logs a cup.
 */
export default function WaterDial({ cups, goal, unit = "cups", onAddCup, onSetCups, children }: {
  cups: number;
  goal: number;
  /** How the counts read; storage and the steps stay whole cups. */
  unit?: WaterUnit;
  onAddCup: () => void;
  onSetCups: (cups: number) => void;
  children: ReactNode;
}) {
  const [slider, setSlider] = useState<number | null>(null);
  // The press is built once and reads the latest props through a plain holder that an effect
  // keeps current (the CoachMic pattern, lib/coach/hold-ports.ts), so a re-render never rebuilds
  // it mid-hold and no React ref is read while rendering.
  const [rig] = useState(() => {
    const latest = { cups, onAddCup, onSetCups };
    let release: (() => void) | null = null;
    const closeSlider = () => { release?.(); release = null; setSlider(null); };
    const press = createWaterPress({
      onTap: () => latest.onAddCup(),
      onHoldStart: (start) => { release = guardSelection(document); setSlider(start); buzz(); },
      onAdjust: (next) => { setSlider(next); buzz(); },
      onCommit: (next) => { closeSlider(); if (next !== null) latest.onSetCups(next); },
      onCancel: closeSlider,
    });
    return {
      press,
      cups: () => latest.cups,
      update(next: typeof latest) { Object.assign(latest, next); },
      dispose() { press.cancel(); },
    };
  });
  useEffect(() => { rig.update({ cups, onAddCup, onSetCups }); });
  useEffect(() => () => rig.dispose(), [rig]);
  const press = rig.press;

  const shown = slider ?? cups;
  const label = `Water: ${goal > 0 ? formatWaterOf(cups, goal, unit) : formatWater(cups, unit)}. `
    + `Tap adds ${stepPhrase(unit)}, hold to adjust`;

  return (
    <div className="relative flex shrink-0 flex-col items-center">
      {slider !== null && <Slider cups={shown} goal={goal} unit={unit} />}
      <button
        type="button"
        aria-label={label}
        className="tap flex flex-col items-center rounded-[16px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-gauge-water)]"
        style={{ touchAction: "pan-y", WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.pointerType === "mouse") return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          press.down(e.clientX, rig.cups());
        }}
        onPointerMove={(e) => press.move(e.clientX)}
        onPointerUp={() => press.up()}
        onPointerCancel={() => press.cancel()}
        onLostPointerCapture={() => { if (press.phase !== "idle") press.cancel(); }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          // Keyboard: Enter/Space add a cup; the arrows adjust by one.
          if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onSetCups(Math.min(MAX_CUPS, cups + 1)); }
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onSetCups(Math.max(0, cups - 1)); }
        }}
      >
        {children}
      </button>
    </div>
  );
}

/** A short tick under the finger on phones that have it; silent elsewhere. */
function buzz() {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(8);
}

/** The pill above the dial while it is held: the count, and a track that fills to the goal. */
function Slider({ cups, goal, unit }: { cups: number; goal: number; unit: WaterUnit }) {
  const span = Math.max(goal, cups, 1);
  const pct = Math.min(100, Math.round((cups / span) * 100));
  return (
    <div
      role="status"
      aria-live="polite"
      className="pill pointer-events-none absolute left-1/2 z-30 -translate-x-1/2"
      style={{ top: -58, width: 148 }}
    >
      <div className="pill-in flex flex-col items-center gap-1.5 px-4 py-2">
        <span className="tabular-nums text-caption font-normal leading-none">
          {formatWater(cups, unit)}
          {goal > 0 && <span className="font-normal text-muted"> of {formatWater(goal, unit)}</span>}
        </span>
        <span className="relative block h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.05)" }}>
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${pct}%`,
              background: "linear-gradient(90deg, var(--color-gauge-water), var(--color-gauge-water-end))",
              transition: "width 120ms ease",
            }}
          />
        </span>
        <span className="text-tiny font-normal leading-none text-muted">
          drag left or right
        </span>
      </div>
    </div>
  );
}
