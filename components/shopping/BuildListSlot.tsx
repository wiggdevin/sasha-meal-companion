"use client";

import BuildListCard from "@/components/shopping/BuildListCard";

/**
 * Where "Have AI build my list" mounts at the top of Shopping (UI makeover §7.1). The props are
 * frozen; the card and its flow are components/shopping/BuildListCard.tsx.
 */
export type BuildListSlotProps = { periodId?: string | null };

export default function BuildListSlot({ periodId }: BuildListSlotProps) {
  return <BuildListCard periodId={periodId ?? null} />;
}
