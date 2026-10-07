"use client";

import { Pill } from "@/components/Sheet";
import { CUISINES, CUISINE_LABELS, CUISINES_MAX, type CuisineKey } from "@/lib/profile/cuisines";

/**
 * The 12 cuisines as toggles (Phase 18 W5), shared by Settings and the onboarding step. At most 6
 * can be on: with 6 chosen, the others are disabled until one is turned off, so no list the
 * server would refuse is ever made. The list is kept in vocabulary order.
 */
export default function CuisineChips({ value, onChange, label }: {
  value: readonly CuisineKey[];
  onChange: (next: CuisineKey[]) => void;
  label: string;
}) {
  const full = value.length >= CUISINES_MAX;
  function toggle(cuisine: CuisineKey): void {
    const on = value.includes(cuisine);
    onChange(CUISINES.filter((key) => (key === cuisine ? !on : value.includes(key))));
  }
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {CUISINES.map((cuisine) => {
        const on = value.includes(cuisine);
        return <Pill key={cuisine} active={on} disabled={!on && full} onClick={() => toggle(cuisine)}>
          {CUISINE_LABELS[cuisine]}
        </Pill>;
      })}
    </div>
  );
}

/** "2 of 6 chosen", or the cap reached. */
export function cuisineCount(count: number): string {
  return count >= CUISINES_MAX ? `${CUISINES_MAX} of ${CUISINES_MAX} chosen. Turn one off to pick another.`
    : `${count} of ${CUISINES_MAX} chosen.`;
}
