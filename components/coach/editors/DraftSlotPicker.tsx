"use client";

import EditorPill from "@/components/coach/editors/EditorPill";
import { SLOT_LABELS } from "@/lib/meals";
import type { SlotId } from "@/lib/types";

const SLOTS: { id: SlotId; label: string }[] = [
  { id: "meal-1", label: "Meal 1" }, { id: "meal-2", label: "Meal 2" },
  { id: "meal-3", label: "Meal 3" }, { id: "meal-4", label: "Meal 4" },
  { id: "meal-5", label: "Meal 5" }, { id: "meal-6", label: "Meal 6" },
];

export default function DraftSlotPicker({ value, onChange }: {
  value: SlotId; onChange: (slot: SlotId) => void;
}) {
  // An existing historical log can keep its saved slot; no new ritual is suggested.
  const options = SLOTS.some((slot) => slot.id === value) ? SLOTS
    : [{ id: value, label: SLOT_LABELS[value] }, ...SLOTS];
  return <div className="flex flex-col gap-2">
    <span className="text-tiny font-normal text-graphite">Slot</span>
    <div className="flex flex-wrap gap-2">
      {options.map((slot) => <EditorPill key={slot.id} active={slot.id === value}
        onClick={() => onChange(slot.id)}>{slot.label}</EditorPill>)}
    </div>
  </div>;
}
