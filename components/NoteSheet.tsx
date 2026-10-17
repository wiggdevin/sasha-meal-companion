"use client";

import { useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import { canonicalNote } from "@/lib/log/note-text";
import { useEntryPhoto } from "@/lib/media/thumbnail-client";
import { eatenBound } from "@/lib/nutrition-display";
import type { LoggedFood } from "@/lib/types";

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

const LABEL = "text-tiny font-normal text-graphite";
const ON_OLIVE = "text-caption font-normal text-charcoal";
const ON_OLIVE_MUTED = "text-tiny font-normal text-muted";

/**
 * A note on a meal — a plan slot or a logged entry — that the user can come back
 * to any time. For a logged entry it also shows what was in it and offers
 * Remove. Saves a changed note on blur and on close, through the shared ActionFeedback: a failure
 * keeps the sheet and the typed note, with the shared alert. A second close right after that failure
 * leaves anyway (the alert already said the note did not save), so a store that stays down never
 * traps the user in the sheet.
 */
export default function NoteSheet({
  title,
  subtitle,
  note,
  entry,
  onSave,
  onSaved,
  onRemove,
  onLogAgain,
  onClose,
}: {
  title: string;
  subtitle?: string;
  note: string;
  entry?: LoggedFood;
  onSave: (note: string) => void | Promise<void>;
  /** The sheet closed after changing the note: the note it opened with, and the one it saved. */
  onSaved?: (before: string, after: string) => void;
  onRemove?: () => void;
  /** Log this entry again as a new one now (W123). Absent when the entry cannot be rebuilt. */
  onLogAgain?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(note);
  /** The note the store last took, in its stored form; an unchanged note is not written again. */
  const saved = useRef(canonicalNote(note));
  /** The note this sheet opened with (stored form); the prop follows the store after each save. */
  const [opened] = useState(() => canonicalNote(note));
  const feedback = useActionFeedback();
  // A plate photo's kept thumbnail (W125, T2); a slot note or a non-photo entry asks nothing.
  const thumb = useEntryPhoto(entry?.id ?? null);
  /** A close tried to save this exact text and failed; the next close just leaves. */
  const closeFailed = useRef(false);
  const close = () => {
    if (saved.current !== opened) onSaved?.(opened, saved.current);
    onClose();
  };
  const save = async (closing = false) => {
    // Compared and sent in the stored form; the box keeps exactly what was typed.
    const next = canonicalNote(text);
    if (next === saved.current) { if (closing) close(); return true; }
    const outcome = await feedback.run(async () => { await onSave(next); saved.current = next; },
      { kind: "commit", failureMessage: "Could not save your note. Please try again." });
    if (outcome.ok && closing) close();
    return outcome.ok;
  };
  const dismiss = async () => {
    if (closeFailed.current) { close(); return; }
    if (!await save(true)) closeFailed.current = true;
  };

  return (
    <Sheet
      title={title}
      subtitle={subtitle}
      onClose={() => { void dismiss(); }}
      footer={
        <div className="flex flex-col gap-2.5">
          <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
          {/* The sheet's primary (lg) confirms in itself ("Saved") when a blur saves the note and
              the sheet stays open; Remove is the destructive neighbour. */}
          <Button variant="primary" size="lg" block confirmLabel="Saved" {...feedback.controlProps}
            onClick={() => { void save(true); }}>
            Save note
          </Button>
          {onLogAgain && <Button block onClick={onLogAgain}>Log again now</Button>}
          {onRemove && <Button variant="danger" block onClick={onRemove}>Remove from today</Button>}
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-0.5">
        {entry && (
          <section className="olive-panel flex flex-col gap-1.5 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed Storage URL */}
            {thumb && <img src={thumb} alt="Your photo of this meal" className="mb-1.5 aspect-[4/3] w-full rounded-[12px] object-cover" />}
            <p className="m-0 text-body font-medium text-on-charcoal tabular-nums">
              <MacroLine values={entry.macros} bound={eatenBound(entry.nutritionPartial === true)} />
            </p>
            {entry.items?.length ? (
              <>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {entry.items.map((i) => (
                    <li key={i.id} className={`flex justify-between gap-2 ${ON_OLIVE}`}>
                      <span className="min-w-0 truncate">{fmt(i.qty)} × {i.portionLabel} {i.name}</span>
                      <span className={`shrink-0 tabular-nums ${ON_OLIVE_MUTED}`}>
                        <MacroFigure macro="kcal" value={i.macros.kcal} /></span>
                    </li>
                  ))}
                </ul>
                {entry.flags?.length ? (
                  <p className="m-0 text-tiny font-normal text-caution">
                    off-plan: {entry.flags.join(", ")}
                  </p>
                ) : null}
              </>
            ) : (
              <p className={`m-0 ${ON_OLIVE_MUTED}`}>
                {fmt(entry.qty)} × {entry.portionLabel}
                {entry.flags?.length ? <span className="text-caution"> · off-plan: {entry.flags.join(", ")}</span> : null}
              </p>
            )}
          </section>
        )}
        <label className="flex flex-col gap-2">
          <span className={`pl-1.5 ${LABEL}`}>Note</span>
          <textarea
            value={text}
            onChange={(e) => { closeFailed.current = false; setText(e.target.value); }}
            onBlur={() => { void save(); }}
            rows={4}
            autoFocus={!entry}
            placeholder="How it went, how you felt after, what you'd change…"
            className="well w-full resize-none px-4 py-3 text-body font-medium text-charcoal"
          />
        </label>
      </div>
    </Sheet>
  );
}
