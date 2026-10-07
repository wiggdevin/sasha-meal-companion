"use client";

/**
 * Onboarding v2, lane 3 — the in-chip birth-year stepper (BRIEF.md §2/§7): "I heard 34 → born
 * 1992?" inline, never a separate wheel screen (cut, §4). The age↔year mapping must always be
 * visible, never silent (critique of B, point 7) — every render shows both numbers, and nudging
 * the year recomputes the spoken age from it rather than hiding one behind the other.
 */
import { birthYearEcho } from "@/components/Onboarding/facts/unit-echo";

const MIN_BIRTH_YEAR = 1900;

export function BirthYearStepper({
  birthYear,
  onChange,
  today = new Date(),
}: {
  birthYear: number;
  onChange: (birthYear: number) => void;
  today?: Date;
}) {
  const maxYear = today.getUTCFullYear();
  function nudge(delta: number) {
    const next = birthYear + delta;
    if (next >= MIN_BIRTH_YEAR && next <= maxYear) onChange(next);
  }
  return (
    <span className="well inline-flex min-h-8 items-center gap-1 rounded-full px-1.5 text-body-sm font-medium text-charcoal" role="group" aria-label="Birth year">
      <button type="button" aria-label="Earlier birth year" onClick={() => nudge(-1)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-body-sm" disabled={birthYear <= MIN_BIRTH_YEAR}>
        {"−"}
      </button>
      <span>{birthYearEcho(birthYear, today)}</span>
      <button type="button" aria-label="Later birth year" onClick={() => nudge(1)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-body-sm" disabled={birthYear >= maxYear}>
        {"+"}
      </button>
    </span>
  );
}
