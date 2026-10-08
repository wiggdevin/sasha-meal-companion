"use client";

/**
 * Onboarding v2 question set §6: the plan card names every default the person did not choose, and
 * every route note (held pace, pregnancy, kidney disease, insulin), each with a Change link back to
 * its beat where one exists. Presentation only.
 */
import Button from "@/components/ui/Button";
import type { PlanNote } from "@/components/Onboarding/v2/plan-answers";

export default function PlanNotes({ notes, onChange }: {
  notes: readonly PlanNote[];
  onChange: (beat: NonNullable<PlanNote["change"]>) => void;
}) {
  if (notes.length === 0) return null;
  return <section className="flex flex-col gap-2" aria-label="What we set for you" data-testid="plan-notes">
    <h2 className="m-0 text-caption font-medium text-graphite">What we set for you</h2>
    <ul className="m-0 flex flex-col gap-2 p-0">
      {notes.map((note) => <li key={note.id} data-note={note.id}
        className="flex items-center justify-between gap-2 rounded-[16px] bg-fog px-3 py-2">
        <span className="text-caption text-charcoal">{note.text}</span>
        {note.change && <Button variant="tertiary" size="sm" className="min-h-11 shrink-0"
          aria-label={`Change: ${note.text}`} onClick={() => onChange(note.change!)}>Change</Button>}
      </li>)}
    </ul>
  </section>;
}
