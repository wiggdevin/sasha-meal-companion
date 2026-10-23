"use client";

import Image from "next/image";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import { MATERIAL_ART, type Award } from "@/components/today/care/awards";
import { named, type MascotKey } from "@/components/today/island/mascots";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/care/Awards.module.css";

/**
 * A message in the open well (owner, 2026-10-07: "what the notifications may look like when they come
 * through"; types and order from GPT-6 Astra's spec §E). The server's care_messages inbox (UI-NEEDS
 * SPROUT-CARE) will feed these; the design gallery feeds samples. One at a time, newest on top; each
 * drops in from the top of the glass and squishes as it lands, and leaves the way it came. The words
 * observe; none tells anyone to eat.
 */
export type CareNote = (
  | { id: string; type: "tip"; title: string; text: string }
  | { id: string; type: "accolade"; award: Award }
  | { id: string; type: "observation"; text: string }
  | { id: string; type: "system"; text: string; retry?: () => void }
  | { id: string; type: "shop"; title: string; text: string }
  | { id: string; type: "streak"; text: string; days: boolean[] }
) & { /** When the server sent it (ms); newest first among messages of the same urgency. */ at?: number };

/** Most urgent first: a blocking sync problem, then an award, a streak, an observation, a tip, the shop. */
export const NOTE_ORDER: CareNote["type"][] = ["system", "accolade", "streak", "observation", "tip", "shop"];
export const nextNote = (notes: CareNote[]): CareNote | null =>
  notes.map((note, i) => ({ note, i }))
    // Most urgent first; among equals the newest (by `at`, else the later one in the list).
    .sort((a, b) => NOTE_ORDER.indexOf(a.note.type) - NOTE_ORDER.indexOf(b.note.type)
      || (b.note.at ?? 0) - (a.note.at ?? 0) || b.i - a.i)[0]?.note ?? null;

function NoteBody({ note, mascot, onWatch, onDismiss }: { note: CareNote; mascot: MascotKey;
  onWatch: (award: Award) => void; onDismiss: () => void }) {
  // Notes are written with Sprout's name and said with the chosen companion's, as the award player says them.
  const say = (text: string) => named(text, mascot);
  switch (note.type) {
    case "accolade":
      return <>
        <span className={styles.noteIcon} aria-hidden="true">
          <Image src={MATERIAL_ART[note.award.material]} alt="" width={64} height={64} sizes="30px" />
        </span>
        <span className={styles.noteBody}>
          <span className={styles.noteTitle}>{say(note.award.title)}</span>
          <span className={styles.noteText}>{say(note.award.line)}</span>
          <span className={styles.noteActions}>
            <Button variant="secondary" size="sm" onClick={() => onWatch(note.award)}>Watch</Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>Later</Button>
          </span>
        </span>
      </>;
    case "streak":
      return <>
        <span className={styles.noteIcon} aria-hidden="true"><span className={styles.noteGlyph} /></span>
        <span className={styles.noteBody}>
          <span className={styles.noteTitle}>{say(note.text)}</span>
          <span className={styles.beads} role="img" aria-label={`${note.days.filter(Boolean).length} of ${note.days.length} days recorded`}>
            {note.days.map((on, i) => <span key={i} className={styles.bead} data-on={on || undefined} />)}
          </span>
        </span>
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">Close</Button>
      </>;
    case "system":
      return <>
        <span className={styles.noteIcon} aria-hidden="true"><span className={styles.noteGlyph} /></span>
        <span className={styles.noteBody}>
          <span className={styles.noteText}>{say(note.text)}</span>
          {note.retry && <span className={styles.noteActions}><Button variant="secondary" size="sm" onClick={note.retry}>Retry</Button></span>}
        </span>
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">Close</Button>
      </>;
    case "observation":
      return <>
        <span className={styles.noteIcon} aria-hidden="true"><span className={styles.noteGlyph} /></span>
        <span className={styles.noteBody}><span className={styles.noteText}>{say(note.text)}</span></span>
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">Close</Button>
      </>;
    default:
      return <>
        <span className={styles.noteIcon} aria-hidden="true">
          {note.type === "tip" ? <Image src="/pet/scene/catch-tip.webp" alt="" width={64} height={64} sizes="30px" />
            : <span className={styles.noteGlyph} />}
        </span>
        <span className={styles.noteBody}>
          <span className={styles.noteTitle}>{say(note.title)}</span>
          <span className={styles.noteText}>{say(note.text)}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">Close</Button>
      </>;
  }
}

/** What a screen reader says when a note lands: its title and words, said with the companion's name. */
export function spokenNote(note: CareNote, mascot: MascotKey): string {
  const say = (text: string) => named(text, mascot);
  switch (note.type) {
    case "accolade": return `${say(note.award.title)}. ${say(note.award.line)}`;
    case "tip": case "shop": return `${say(note.title)}. ${say(note.text)}`;
    default: return say(note.text);
  }
}

export default function CareNotes({ note, mascot = "sprout", place = "top", onWatch, onDismiss }: {
  note: CareNote | null; mascot?: MascotKey;
  /** "bottom" keeps the note clear of a view's own top-strip controls (the water view's Add a cup). */
  place?: "top" | "bottom";
  onWatch: (award: Award) => void; onDismiss: (id: string) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  // The live region stays mounted and only its words change: a region created in the same commit as
  // its text is usually not announced (VoiceOver, NVDA), and the card itself holds buttons.
  return <div className={styles.notes} data-place={place === "bottom" ? "bottom" : undefined}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{note ? spokenNote(note, mascot) : ""}</span>
    <AnimatePresence mode="popLayout" initial={false}>
      {note && <motion.div key={note.id} className={styles.note} data-type={note.type}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -40, scaleY: 0.9 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scaleY: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -30, transition: FADES.quick }}
        transition={reduce ? INSTANT : SPRINGS.bouncy}>
        <NoteBody note={note} mascot={mascot} onWatch={onWatch} onDismiss={() => onDismiss(note.id)} />
      </motion.div>}
    </AnimatePresence>
  </div>;
}
