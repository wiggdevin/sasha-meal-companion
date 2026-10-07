import type { generatedNotesForDay } from "@/lib/resolve";
import type { ResolvedSlot, StoredDay } from "@/lib/types";

export type GeneratedNotes = NonNullable<ReturnType<typeof generatedNotesForDay>>;
export type SlotNote = { emptyReason: string | null; planMiss: string | null };

const NONE: SlotNote = { emptyReason: null, planMiss: null };

/**
 * The quiet line a Today card carries from the day's generator run (Phase 17 O1, U28/U29). An
 * empty, unticked slot the generator could not fill says why; an unticked card still showing the
 * generated plate says when that plate misses the meal's target. A slot the person edited, cleared,
 * ate from a recipe or ticked shows neither: the line describes the generator's plate, not theirs.
 */
export function slotNote(slot: ResolvedSlot, day: StoredDay | undefined,
  notes: GeneratedNotes | null): SlotNote {
  if (!notes || slot.eaten || day?.consumedSlots?.[slot.slot]) return NONE;
  const override = day?.itemOverrides?.[slot.slot];
  if (slot.meal === null) {
    return override?.cleared ? NONE
      : { emptyReason: notes.shortages[slot.slot]?.reason ?? null, planMiss: null };
  }
  const followsPlan = !override || (override.followPlan === true && !override.title);
  return followsPlan ? { emptyReason: null, planMiss: notes.misses[slot.slot] ?? null } : NONE;
}

/** Today's protein notice (U30): a protein may repeat, so it shows only when a slot has none. */
export function proteinShortfall(notes: GeneratedNotes | null): { available: number; required: number } | null {
  if (!notes || notes.proteins.required <= notes.proteins.available) return null;
  return notes.proteins;
}
