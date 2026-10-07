import type { StoredDay } from "@/lib/types";

type NormalizedPlanDay = StoredDay & { _normalizedPlan: true };

/** Local-only marker, retained by localStorage and stripped from legacy HTTP writes. Once this
 * date uses normalized plan sync, legacy snapshots own logs/marks but cannot replace its plan. */
export function withPlanAuthority(day: StoredDay): NormalizedPlanDay {
  return { ...day, _normalizedPlan: true };
}

export function preserveNormalizedPlan(local: StoredDay | undefined, incoming: StoredDay): StoredDay {
  if (!local || (local as Partial<NormalizedPlanDay>)._normalizedPlan !== true) return incoming;
  return withPlanAuthority({
    ...incoming,
    dayTypeOverride: local.dayTypeOverride, floorDay: local.floorDay,
    swaps: local.swaps, notes: local.notes, itemOverrides: local.itemOverrides,
    dayCompleteAt: local.dayCompleteAt,
  });
}
