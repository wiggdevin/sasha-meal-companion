"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import Button from "@/components/ui/Button";
import AwardPlayer from "@/components/today/care/AwardPlayer";
import CareNotes, { nextNote, type CareNote } from "@/components/today/care/CareNotes";
import { AWARDS, awardByKey, type Award } from "@/components/today/care/awards";
import { SproutFigure } from "@/components/today/island/SproutFigure";
import { unlockAudio } from "@/components/today/care/sound";
import styles from "@/app/design/AwardsGallery.module.css";

/** Sample messages: what the server's inbox will send (UI-NEEDS SPROUT-CARE). */
const SAMPLES: CareNote[] = [
  { id: "tip", type: "tip", title: "A little tip", text: "Tap the rainbow over the pond to see what remains today." },
  { id: "accolade", type: "accolade", award: awardByKey("workout-pair")! },
  { id: "observation", type: "observation", text: "Sprout is waiting for you." },
  { id: "system", type: "system", text: "Saved here. Sync is pending.", retry: () => {} },
  { id: "shop", type: "shop", title: "New in the shop", text: "A tiny bucket hat, 25 Seeds." },
  { id: "streak", type: "streak", text: "Five days recorded this week.", days: [true, true, false, true, true, true, false] },
];

/** Every award and every message type, played in a stand-in for the open well (owner, 2026-10-07). */
export default function AwardsGallery() {
  const [award, setAward] = useState<Award | null>(null);
  const [notes, setNotes] = useState<CareNote[]>([]);
  const [glint, setGlint] = useState(0);
  const note = nextNote(notes);
  const push = (sample: CareNote) => { setNotes((list) => [...list.filter((n) => n.id !== sample.id), { ...sample }]); setGlint((g) => g + 1); };
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">Awards and messages</h1>
    <section aria-label="The open well" className={styles.well} tabIndex={-1}>
      <span className={styles.sprout}><SproutFigure mood="content" size={160} /></span>
      <CareNotes note={note} onWatch={(a) => { unlockAudio(); setNotes((list) => list.filter((n) => n.type !== "accolade")); setAward(a); }}
        onDismiss={(id) => setNotes((list) => list.filter((n) => n.id !== id))} />
      <AnimatePresence>{award && <AwardPlayer key={award.key} award={award} onClose={() => setAward(null)} />}</AnimatePresence>
    </section>
    <section aria-label="The collapsed pill" className={styles.pill}>
      <SproutFigure mood="content" size={40} />
      <span className={styles.pillText}>1,879 <span className={styles.pillWord}>kcal left</span></span>
      {notes.length > 0 && <span className={styles.pillGlyph} aria-label={`${notes.length} new`} role="img" />}
      <span key={glint} aria-hidden="true" className={styles.glint} />
    </section>
    <h2 className="m-0 text-caption font-semibold text-muted">Messages</h2>
    <div className="flex flex-wrap gap-2">
      {SAMPLES.map((sample) => <Button key={sample.id} variant="secondary" size="sm" onClick={() => push(sample)}>{sample.type}</Button>)}
    </div>
    <h2 className="m-0 text-caption font-semibold text-muted">Awards</h2>
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {AWARDS.map((a) => <li key={a.key} className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-semibold text-charcoal">{a.title}</span>
          <span className="text-caption text-muted">{a.material} · {a.scene} · {a.trigger}</span>
        </span>
        <Button variant="secondary" size="sm" onClick={() => { unlockAudio(); setAward(a); }}>Play</Button>
      </li>)}
    </ul>
  </main>;
}
