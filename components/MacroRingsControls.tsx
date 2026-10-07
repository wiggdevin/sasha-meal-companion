"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { selectionHaptic } from "@/lib/haptics";
import { LONG_PRESS_MS, PRESS_SLOP_PX } from "@/lib/today/presentation";
import { cupsFromDrag, MAX_CUPS, PX_PER_CUP } from "@/lib/today/water-gesture";
import { formatWater, type WaterUnit } from "@/lib/water-units";

/* The progress card's controls (FluidVoice T02/T07), kept apart from components/MacroRings.tsx so
   the dial module stays under the house 400-line rule. */

/**
 * The water dial's visible step controls: the same bound as the drag (`cupsFromDrag` over one
 * cup of travel), so a step and a drag can never disagree about the day's count.
 */
export function WaterSteps({ cups, onSetCups, label, unit = "cups" }: {
  cups: number; onSetCups: (cups: number) => void;
  /** How one step reads: a cup, or the same step in oz or ml (lib/water-units). */
  unit?: WaterUnit;
  /** With a label the steps stand alone as a row (the collapsed card); without, they sit under the dial. */
  label?: ReactNode;
}) {
  const step = (direction: -1 | 1) => onSetCups(cupsFromDrag(cups, direction * PX_PER_CUP));
  const mark = "flex h-7 w-7 items-center justify-center rounded-full border border-hairline text-[16px] leading-none text-graphite";
  const step1 = unit === "cups" ? null : formatWater(1, unit);
  const less = <button type="button" aria-label={step1 ? `${step1} less water` : "One less cup of water"} disabled={cups <= 0}
    onClick={() => step(-1)} className="tap flex h-11 w-11 items-center justify-center disabled:opacity-40">
    <span aria-hidden="true" className={mark}>−</span>
  </button>;
  const more = <button type="button" aria-label={step1 ? `${step1} more water` : "One more cup of water"} disabled={cups >= MAX_CUPS}
    onClick={() => step(1)} className="tap flex h-11 w-11 items-center justify-center disabled:opacity-40">
    <span aria-hidden="true" className={mark}>+</span>
  </button>;
  if (label !== undefined) {
    return (
      <div role="group" aria-label="Water" className="flex items-center justify-center gap-1 text-xs">
        {less}<span className="tabular-nums">{label}</span>{more}
      </div>
    );
  }
  // Two 44 px targets are wider than the 56 px dial column at 320 px: the pair is centred under the
  // dial without widening its column, so the gauge row still fits the card.
  return (
    <div className="relative h-11 w-full">
      <div className="absolute left-1/2 top-0 flex -translate-x-1/2 items-center">{less}{more}</div>
    </div>
  );
}

/**
 * A long press on the "Still to eat" line (FluidVoice T07). Movement past the slop, a lift or a
 * cancel before the hold matures does nothing; presses that start on a button are the button's.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef(onLongPress);
  useEffect(() => { latest.current = onLongPress; });
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown(event: React.PointerEvent) {
      if (event.target instanceof Element && event.target.closest("button")) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      clear();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        start.current = null;
        selectionHaptic();
        latest.current();
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: React.PointerEvent) {
      const from = start.current;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > PRESS_SLOP_PX) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu(event: React.MouseEvent) { event.preventDefault(); },
  };
}

/** Three stemless chevrons pointing where the detail will go; CSS runs their glow in sequence. */
export function Chevrons({ direction }: { direction: "up" | "down" }) {
  return (
    <span aria-hidden="true" data-chevrons={direction} className="macro-chevrons">
      <span data-chevron className="macro-chevron" />
      <span data-chevron className="macro-chevron" />
      <span data-chevron className="macro-chevron" />
    </span>
  );
}
