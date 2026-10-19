"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { SPRINGS } from "@/lib/design/motion";

/**
 * The two-segment ink pill from Foods.dc.html, as real tabs. It was a pair of `aria-pressed`
 * buttons inside MyFoods.tsx; on the Foods tab it switches the whole page, which is a tablist.
 *
 * The selected segment keeps its 36 px visual, but the <button> around it is the full 44 px of
 * the pill so the hit box clears DESIGN.md Layout ("Every tap target is at least 44 × 44 px").
 * Both tabs stay in the tab order — there are two of them and no arrow-key handler to rescue a
 * roving tabindex.
 *
 * The olive lens is one element that slides to the chosen segment on the snappy spring
 * (2026-10-01), so changing tab reads as the selection moving, never as two pills swapping.
 */

export function tabId(value: string): string {
  return `tab-${value}`;
}

export default function Segmented<T extends string>({ label, options, value, onChange, panel }: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** The id of the one panel both tabs swap the contents of. */
  panel: string;
}) {
  const lens = useId();
  const reduceMotion = useReducedMotion();
  return (
    <div className="pill inline-flex shrink-0">
      <div
        role="tablist"
        aria-label={label}
        className="pill-in flex h-11 items-center gap-0.5 px-1"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              id={tabId(option.value)}
              aria-selected={selected}
              aria-controls={panel}
              onClick={() => onChange(option.value)}
              className="tap relative flex h-11 items-center justify-center"
            >
              {selected && <motion.span aria-hidden="true" layoutId={lens} className="segment-lens absolute inset-x-0 inset-y-1"
                transition={reduceMotion ? { duration: 0 } : SPRINGS.snappy} />}
              <span className={`segment-label relative flex h-9 items-center justify-center px-3.5 text-[14px] ${
                selected ? "text-on-primary" : "text-graphite"}`}>
                {option.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
