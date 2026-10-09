"use client";

/**
 * Onboarding v2: one typed-first preference question (owner, 2026-10-08) — food practices, foods to
 * stay away from, or favored cuisines. The person types the answer the way they would say it; the
 * caller's `parse` reads it on the phone by keyword (lib/profile/onboarding-prefs-parse.ts, no
 * model call) and the reading shows under the box as they type. "Just pick from the list" opens the
 * shared tile grid (`TileGrid`); a typed answer and a tile tap write the same selection.
 *
 * Text that reads as a health or allergy detail (`onboardingSafetyCheck`, the opener's own gate) is
 * never read here: the safety round owns those answers.
 */
import { useId, useMemo, useState, type FormEvent } from "react";
import Button from "@/components/ui/Button";
import { onboardingSafetyCheck } from "@/lib/coach/onboarding-safety";
import { FIELD_CLASS } from "@/components/Onboarding/facts/FactQuestion";
import TileGrid, { type Tile } from "@/components/Onboarding/TileGrid";

export type PrefsReading = { ids: string[]; none: boolean };

const HEALTH_NOTE = "That sounds like a health or allergy detail. Your allergy answers cover those; you can add more in Foods › Avoids.";

export default function PrefsBeat({ question, helper, inputLabel, placeholder, tiles, labelFor, parse, initial,
  max, unreadNote, onDone }: {
  question: string;
  helper: string;
  inputLabel: string;
  placeholder: string;
  tiles: readonly Tile[];
  /** The short label for an id the person typed that is not one of the tiles. */
  labelFor: (id: string) => string;
  parse: (text: string) => PrefsReading;
  initial: readonly string[] | null;
  /** At most this many may be chosen. */
  max?: number;
  unreadNote: string;
  onDone: (ids: string[]) => void;
}) {
  const questionId = useId();
  const inputId = useId();
  const readId = useId();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>(() => [...(initial ?? [])]);
  const [listOpen, setListOpen] = useState(false);
  const [capNote, setCapNote] = useState(false);

  const blocked = text.trim() !== "" && onboardingSafetyCheck(text).blocked;
  const reading = useMemo<PrefsReading | null>(
    () => (text.trim() === "" || blocked ? null : parse(text)), [text, blocked, parse]);
  const unread = !!reading && reading.ids.length === 0 && !reading.none;
  const chosen = useMemo(() => {
    // A typed "none" is a correction: it clears every choice on this question, typed or tapped.
    if (reading?.none) return [];
    const all = [...picked, ...(reading?.ids ?? []).filter((id) => !picked.includes(id))];
    return max === undefined ? all : all.slice(0, max);
  }, [picked, reading, max]);
  const selected = useMemo(() => new Set(chosen), [chosen]);
  const allTiles = useMemo(() => [
    ...tiles,
    ...chosen.filter((id) => !tiles.some((tile) => tile.id === id))
      .map((id) => ({ id, label: labelFor(id), ariaLabel: labelFor(id) })),
  ], [tiles, chosen, labelFor]);

  function openList() {
    // The typed reading becomes taps, so the grid shows it and a tap can take it back.
    setPicked(chosen);
    setText("");
    setListOpen(true);
  }

  function toggle(id: string, next: boolean) {
    setCapNote(false);
    if (!next) { setPicked(chosen.filter((item) => item !== id)); return; }
    if (max !== undefined && chosen.length >= max) { setCapNote(true); return; }
    setPicked([...chosen, id]);
  }

  /** "None of these": nothing on this question, and on to the next one. */
  function none() {
    setPicked([]);
    setText("");
    onDone([]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || unread) return;
    onDone(chosen);
  }

  const readLine = reading && reading.ids.length > 0
    ? `Got it: ${reading.ids.slice(0, max ?? reading.ids.length).map(labelFor).join(" · ")}` : null;

  return <form aria-labelledby={questionId} onSubmit={submit} className="flex w-full flex-col gap-3">
    <p id={questionId} className="m-0 font-serif text-heading-sm text-charcoal">{question}</p>
    <p className="m-0 text-caption text-graphite">{helper}</p>
    {!listOpen && <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={inputId} className="text-caption text-graphite">{inputLabel}</label>
      <input id={inputId} type="text" autoComplete="off" spellCheck={false} enterKeyHint="done"
        placeholder={placeholder} value={text} aria-describedby={readId}
        onChange={(event) => setText(event.target.value)} className={FIELD_CLASS} />
      <p id={readId} className="m-0 min-h-5 text-caption text-graphite" aria-live="polite">
        {readLine ?? (chosen.length > 0 && !text.trim() ? `Chosen: ${chosen.map(labelFor).join(" · ")}` : "")}
      </p>
    </div>}
    {blocked && <p role="alert" className="m-0 text-caption text-alert">{HEALTH_NOTE}</p>}
    {unread && <p role="alert" className="m-0 text-caption text-alert">{unreadNote}</p>}
    {listOpen && <TileGrid tiles={allTiles} selected={selected} onToggle={toggle} columns={3} size="md" />}
    <div className="flex w-full gap-2">
      {!listOpen && <Button type="button" variant="tertiary" size="md" className="min-h-11 flex-1" onClick={openList}>
        Just pick from the list
      </Button>}
      <Button type="button" variant="tertiary" size="md" className="min-h-11 flex-1" onClick={none}>
        None of these
      </Button>
    </div>
    {capNote && max !== undefined && <p role="status" className="m-0 text-caption text-graphite">Up to {max}. Tap one to swap it out.</p>}
    <Button type="submit" variant="primary" size="lg" block disabled={blocked || unread}>Next</Button>
  </form>;
}
