"use client";

import Button from "@/components/ui/Button";
import type { OrbitWater } from "@/lib/today/health-orbit";

/** "Add a cup of water. 4 of 8 cups." — the goal only when there is one; nothing while loading. */
export function cupName(water: OrbitWater | undefined): string {
  if (!water) return "Add a cup of water.";
  const cups = Math.max(0, Math.round(water.cups));
  if (water.goal > 0) return `Add a cup of water. ${cups} of ${Math.round(water.goal)} cups.`;
  return `Add a cup of water. ${cups} ${cups === 1 ? "cup" : "cups"}.`;
}

/**
 * The Day card's cup (UI makeover §4, header row 1, on both faces). Interim (W0): one 44 px
 * "Add a cup" pill that adds one stored cup. W2 replaces it with the droplet pill, its "4/8" count
 * and the hold-and-slide scrub (`onSetCups`).
 */
export default function CupSlot({ water, onAddCup }: {
  water?: OrbitWater;
  onAddCup?: () => void;
  /** The day's new total in cups, written once (W2's scrub and keyboard amount). */
  onSetCups?: (cups: number) => void;
}) {
  return <Button variant="secondary" size="md" className="shrink-0" aria-label={cupName(water)}
    disabled={!onAddCup} onClick={() => onAddCup?.()}>
    Add a cup
  </Button>;
}
