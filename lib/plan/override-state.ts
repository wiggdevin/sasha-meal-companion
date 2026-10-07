/**
 * What a slot override holds, for an Undo's "has it changed since?": the fields a person or a meal
 * edit can change, read the same way whatever their key order, with an absent flag equal to
 * `false`. The write's `mutationId` counts too (review t4r10 #5): skip → restore → skip leaves an
 * override equal in every field but written by a later action, which the first skip's Undo must
 * not take back.
 *
 * Pure. The phone's skip Undo (lib/coach/apply-skip.ts) and the server's coach Undo
 * (lib/server/coach-undo.ts) compare with this one function.
 */
import type { SlotOverride } from "@/lib/types";

export function slotState(override: SlotOverride | null | undefined): string {
  if (!override) return "null";
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]))
      : value;
  return JSON.stringify(sorted({
    baseMealId: override.baseMealId ?? null, components: override.components ?? [],
    title: override.title ?? null, followPlan: override.followPlan === true,
    time: override.time ?? null, added: override.added === true,
    removed: override.removed === true, cleared: override.cleared === true,
    mutationId: override.mutationId ?? null,
  }));
}
