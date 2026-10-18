"use client";

import { useState } from "react";
import { parseGramsText } from "@/lib/log/grams";

const META = "text-tiny font-normal text-muted";
const SECTION = "text-tiny font-normal text-graphite";

/**
 * An exact amount beside a ± stepper: the stepper alone moved 150 g to 400 g in 50 taps (UI audit
 * 2026-10-18 §6). The box follows the value when a tap or a portion changes it, and only a readable
 * number is handed on; on blur the box shows the value again if the two differ.
 */
export default function GramsField({ value, onGrams, label = "Exact grams" }: {
  value: number;
  onGrams: (grams: number) => void;
  label?: string;
}) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (parseGramsText(text) !== value) setText(String(value));
  }
  return (
    <label className="flex items-center justify-between gap-4">
      <span className={SECTION} aria-hidden="true">Exact grams</span>
      <span className="well flex h-11 w-28 shrink-0 items-center gap-2 px-3">
        <input value={text} inputMode="decimal" aria-label={label}
          onChange={(event) => {
            setText(event.target.value);
            const grams = parseGramsText(event.target.value);
            if (grams !== null) onGrams(grams);
          }}
          onBlur={() => { if (parseGramsText(text) !== value) setText(String(value)); }}
          className="min-w-0 flex-1 bg-transparent text-right text-caption tabular-nums text-charcoal outline-none" />
        <span className={META}>g</span>
      </span>
    </label>
  );
}
