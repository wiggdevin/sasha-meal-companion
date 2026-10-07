"use client";

import Chip from "@/components/ui/Chip";
import { useId, useState } from "react";
import {
  CM_MAX,
  CM_MIN,
  FEET_MAX,
  FEET_MIN,
  INCHES_MAX,
  INCHES_MIN,
  cmToFtIn,
  ftInToCm,
  isValidCm,
  isValidFtIn,
  type HeightUnit,
} from "@/lib/units/height";

export type HeightFieldProps = {
  valueCm: number | null;
  unit: HeightUnit;
  onChange: (cm: number | null) => void;
  onUnitChange: (unit: HeightUnit) => void;
};

const INPUT = "well min-h-11 min-w-0 bg-transparent px-3 text-body text-charcoal tabular-nums outline-none placeholder:text-muted";

function drafts(valueCm: number | null): { cm: string; ft: string; inches: string } {
  if (valueCm === null) return { cm: "", ft: "", inches: "" };
  const imperial = cmToFtIn(valueCm);
  return { cm: String(Math.round(valueCm * 10) / 10), ft: String(imperial.ft),
    inches: String(imperial.in) };
}

type DisplayState = ReturnType<typeof drafts> & {
  valueCm: number | null;
  unit: HeightUnit;
  error: string | null;
};

function displayState(valueCm: number | null, unit: HeightUnit): DisplayState {
  return { ...drafts(valueCm), valueCm, unit, error: null };
}

export default function HeightField({ valueCm, unit, onChange, onUnitChange }: HeightFieldProps) {
  const id = useId();
  const [edited, setEdited] = useState(() => displayState(valueCm, unit));
  const display = edited.valueCm === valueCm && edited.unit === unit
    ? edited
    : displayState(valueCm, unit);

  function editCm(raw: string): void {
    if (raw.trim() === "") {
      setEdited({ ...display, cm: raw, error: null }); return;
    }
    const cm = Number(raw);
    if (!isValidCm(cm)) {
      setEdited({ ...display, cm: raw, error: `Enter ${CM_MIN} to ${CM_MAX} cm.` }); return;
    }
    setEdited({ ...display, cm: raw, error: null });
  }

  function commitCm(): void {
    if (display.cm.trim() === "") { onChange(null); return; }
    const cm = Number(display.cm);
    if (isValidCm(cm)) onChange(Math.round(cm * 10) / 10);
  }

  function editImperial(key: "ft" | "inches", raw: string): void {
    const next = { ...display, [key]: raw };
    if (next.ft.trim() === "" && next.inches.trim() === "") {
      setEdited({ ...next, error: null }); return;
    }
    const ft = Number(next.ft);
    const inches = Number(next.inches);
    const cm = ftInToCm(ft, inches);
    if (!isValidFtIn(ft, inches) || !isValidCm(cm)) {
      setEdited({ ...next,
        error: `Enter ${FEET_MIN} to ${FEET_MAX} feet and ${INCHES_MIN} to ${INCHES_MAX} inches, within ${CM_MAX} cm.` });
      return;
    }
    setEdited({ ...next, error: null });
  }

  function commitImperial(): void {
    if (display.ft.trim() === "" && display.inches.trim() === "") {
      onChange(null); return;
    }
    const ft = Number(display.ft);
    const inches = Number(display.inches);
    const cm = ftInToCm(ft, inches);
    if (isValidFtIn(ft, inches) && isValidCm(cm)) onChange(cm);
  }

  return (
    <fieldset aria-label="Height" className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend className="mb-1.5 text-caption font-medium text-charcoal">Height</legend>
      <div className="pill-in grid min-h-11 grid-cols-2 gap-1 p-1" aria-label="Height unit">
        <Chip aria-label="Feet and inches" selected={unit === "ft_in"} onClick={() => onUnitChange("ft_in")}>ft / in</Chip>
        <Chip aria-label="Centimetres" selected={unit === "cm"} onClick={() => onUnitChange("cm")}>cm</Chip>
      </div>
      {unit === "ft_in" ? (
        <div className="grid grid-cols-2 gap-3">
          <label htmlFor={`${id}-ft`} className="flex min-w-0 flex-col gap-1.5 text-tiny text-muted">
            Feet
            <input id={`${id}-ft`} type="text" aria-label="Feet" inputMode="numeric" value={display.ft}
              placeholder="ft" onChange={(event) => editImperial("ft", event.target.value)}
              onBlur={commitImperial} className={INPUT} />
          </label>
          <label htmlFor={`${id}-in`} className="flex min-w-0 flex-col gap-1.5 text-tiny text-muted">
            Inches
            <input id={`${id}-in`} type="text" aria-label="Inches" inputMode="numeric" value={display.inches}
              placeholder="in" onChange={(event) => editImperial("inches", event.target.value)}
              onBlur={commitImperial} className={INPUT} />
          </label>
        </div>
      ) : (
        <label htmlFor={`${id}-cm`} className="flex min-w-0 flex-col gap-1.5 text-tiny text-muted">
          Centimetres
          <input id={`${id}-cm`} type="text" aria-label="Height in centimetres" inputMode="numeric"
            value={display.cm} placeholder="cm" onChange={(event) => editCm(event.target.value)}
            onBlur={commitCm} className={INPUT} />
        </label>
      )}
      {display.error && <p role="alert" className="m-0 text-caption text-alert">{display.error}</p>}
    </fieldset>
  );
}
