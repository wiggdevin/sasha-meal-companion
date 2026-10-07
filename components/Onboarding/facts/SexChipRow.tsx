"use client";

/**
 * Onboarding v2, lane 3 — the respectful sex question (BRIEF.md §2/§4): "Now the boring part,
 * for the math — are you male or female?" with a clear, equal-sized "Prefer not to say" path
 * (orchestrator decision, 2026-10-07, coord.md). All three chips are the same size and weight —
 * none of them reads as the "normal" answer — and every tap, including this one, always needs
 * its own tap; none is ever auto-confirmed from speech alone (BRIEF §2 safety note).
 */
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";
import { PREFER_NOT_TO_SAY_NOTE, type SexAnswer } from "@/components/Onboarding/facts/types";

const CAPTION = "text-tiny font-normal text-muted";

const OPTIONS: { value: SexAnswer; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "unspecified", label: "Prefer not to say" },
];

export function SexChipRow({
  value,
  onSelect,
}: {
  value?: SexAnswer;
  onSelect: (value: SexAnswer) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-body text-charcoal">
        Now the boring part, for the math — are you male or female?
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Sex">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            aria-pressed={value === option.value}
            className={`${CHIP_FILL} min-h-11 min-w-0 flex-1 basis-0 rounded-full px-3 text-center text-body-sm font-medium text-charcoal data-[pressed=true]:text-on-primary`}
            data-pressed={value === option.value}
            style={value === option.value ? { background: "var(--grad-ink)" } : undefined}
          >
            {option.label}
          </button>
        ))}
      </div>
      {value === "unspecified" && (
        <p className={`m-0 ${CAPTION}`} role="status">{PREFER_NOT_TO_SAY_NOTE}</p>
      )}
    </div>
  );
}
