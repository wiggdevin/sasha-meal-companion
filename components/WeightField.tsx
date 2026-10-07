"use client";

import Chip from "@/components/ui/Chip";
import { useId, useState } from "react";
import { kgToLb, lbToKg, type WeightUnit } from "@/lib/health/units";

export type WeightFieldProps = {
  valueKg: number | null;
  unit: WeightUnit;
  onChange: (kg: number | null) => void;
  onUnitChange: (unit: WeightUnit) => void;
};

const KG_MIN = 20;
const KG_MAX = 400;

function displayWeight(valueKg: number | null, unit: WeightUnit): string {
  if (valueKg === null) return "";
  const value = unit === "lb" ? kgToLb(valueKg) : valueKg;
  return String(Math.round(value * 10) / 10);
}

export default function WeightField({ valueKg, unit, onChange, onUnitChange }: WeightFieldProps) {
  const id = useId();
  const [edited, setEdited] = useState(() => ({ valueKg, unit,
    display: displayWeight(valueKg, unit), error: null as string | null }));
  const current = edited.valueKg === valueKg && edited.unit === unit
    ? edited
    : { valueKg, unit, display: displayWeight(valueKg, unit), error: null };

  function edit(raw: string): void {
    if (raw.trim() === "") {
      setEdited({ ...current, display: raw, error: null }); return;
    }
    const value = Number(raw);
    const kg = unit === "lb" ? lbToKg(value) : value;
    if (!Number.isFinite(value) || kg < KG_MIN || kg > KG_MAX) {
      setEdited({ ...current, display: raw,
        error: unit === "lb" ? "Enter a weight from 44 to 882 lb."
          : "Enter a weight from 20 to 400 kg." });
      return;
    }
    setEdited({ ...current, display: raw, error: null });
  }

  function commit(): void {
    if (current.display.trim() === "") { onChange(null); return; }
    const value = Number(current.display);
    const kg = unit === "lb" ? lbToKg(value) : value;
    if (Number.isFinite(value) && kg >= KG_MIN && kg <= KG_MAX) {
      onChange(Math.round(kg * 1000) / 1000);
    }
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0">
      <legend className="mb-1.5 text-caption font-medium text-charcoal">Weight</legend>
      <div className="pill-in grid min-h-11 grid-cols-2 gap-1 p-1" aria-label="Weight unit">
        {(["lb", "kg"] as const).map((candidate) => (
          <Chip key={candidate} aria-label={candidate === "lb" ? "Pounds" : "Kilograms"}
            selected={unit === candidate} onClick={() => onUnitChange(candidate)}>{candidate}</Chip>
        ))}
      </div>
      <label htmlFor={`${id}-weight`} className="flex min-w-0 flex-col gap-1.5 text-tiny text-muted">
        {unit === "lb" ? "Pounds" : "Kilograms"}
        <input id={`${id}-weight`} aria-label={`Weight in ${unit === "lb" ? "pounds" : "kilograms"}`}
          inputMode="decimal" value={current.display} onChange={(event) => edit(event.target.value)}
          onBlur={commit}
          placeholder={unit === "lb" ? "lb" : "kg"}
          className="well min-h-11 min-w-0 bg-transparent px-3 text-body text-charcoal tabular-nums outline-none placeholder:text-muted" />
      </label>
      {current.error && <p role="alert" className="m-0 text-caption text-alert">{current.error}</p>}
    </fieldset>
  );
}
