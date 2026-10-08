"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import Sparks, { type SparksApi } from "@/components/today/care/Sparks";
import { BatScene, FlexScene, TokenScene } from "@/components/today/care/scenes";
import { play, readMuted, silence, unlockAudio, writeMuted, type Cue } from "@/components/today/care/sound";
import type { Award } from "@/components/today/care/awards";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import styles from "@/components/today/care/Awards.module.css";
import { named } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";

/**
 * An award, played inside the open well (owner, 2026-10-07: "really incredible animations"). The room
 * dims, the award's scene runs (a material token off the walls, the buff workout, the bat night), it
 * locks in with its sound, and its title and line rise. Skip ends the scene on its finished frame;
 * Replay runs it again; Done or Escape closes it and hands focus back. Reduced motion shows the finished
 * frame with no motion and no sound. The sound plays only after the user's own tap opened the award:
 * the caller calls `unlockAudio()` in that tap's handler (this player's first commit is the fallback).
 * Mute, Skip and closing stop any sound already playing.
 * It is a panel inside the card, not a page-wide modal: Escape works from anywhere while it is open,
 * and closing hands focus back to what opened it, or to the card when that is gone.
 */
export default function AwardPlayer({ award, onClose, modal = false }: {
  award: Award;
  onClose: () => void;
  /** Played over Today, where the caller keeps the rest of the page out of reach: say so to assistive tech. */
  modal?: boolean;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  const sparks = useRef<SparksApi | null>(null);
  const self = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const home = useRef<HTMLElement | null>(null);
  const [run, setRun] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [done, setDone] = useState(false);
  // Read before the first paint and before any cue (scenes start a tick later); the server render and
  // the first browser render both start unmuted, so they agree.
  const [muted, setMuted] = useState(false);
  // The scenes read sound through this, so muting mid-scene silences the rest of it.
  const mutedNow = useRef(false);
  // Once closing starts (its exit fade runs ~250 ms), no cue may start and none may keep playing.
  const closing = useRef(false);

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  // In the commit of the tap that opened the award: the browser lets sound start here.
  useLayoutEffect(() => {
    const saved = readMuted();
    mutedNow.current = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(saved);
    if (!reduce && !saved) unlockAudio();
  }, [reduce]);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    home.current = self.current?.parentElement ?? null;
    self.current?.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); silence(); closing.current = true; onCloseRef.current(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      silence();
      document.removeEventListener("keydown", onKey);
      const back = opener.current?.isConnected ? opener.current : home.current;
      back?.focus?.({ preventScroll: true });
    };
  }, []);

  const cue = (sound: Cue) => { if (!mutedNow.current && !reduce && !closing.current) play(sound); };
  const close = () => { silence(); closing.current = true; onClose(); };
  const final = reduce || skipped;
  const Scene = award.scene === "flex" ? FlexScene : award.scene === "bat" ? BatScene : TokenScene;
  const replay = () => { setSkipped(false); setDone(false); setRun((n) => n + 1); };
  const skip = () => { silence(); setSkipped(true); setRun((n) => n + 1); };

  return <motion.div ref={self} role="dialog" aria-modal={modal || undefined} aria-label={`Award: ${award.title}`} tabIndex={-1}
    className={`matte ${styles.player}`} data-material={award.material} data-scene={award.scene}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
    <div aria-hidden="true" className={styles.dim} />
    <div className={styles.box} key={run}>
      <Scene award={award} sparks={sparks} cue={cue} final={final} onDone={() => setDone(true)} />
    </div>
    <Sparks ref={sparks} still={reduce} />
    <AnimatePresence>
      {done && <motion.div key="words" className={styles.words}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(6px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
        transition={reduce ? INSTANT : { ...SPRINGS.smooth, delay: 0.1 }}>
        <p className={styles.title}>{award.title}</p>
        <p className={styles.line}>{named(award.line, mascot)}</p>
      </motion.div>}
    </AnimatePresence>
    <p className="sr-only" aria-live="polite">{done ? named(`${award.title}. ${award.line}`, mascot) : ""}</p>
    <div className={styles.controls}>
      <Button variant="ghost" size="sm" aria-pressed={!muted}
        onClick={() => {
          const next = !muted;
          mutedNow.current = next;
          writeMuted(next);
          setMuted(next);
          if (next) silence(); else unlockAudio();
        }}>
        {muted ? "Sound off" : "Sound on"}
      </Button>
      <div>
        {done ? <>
          {!reduce && <Button variant="ghost" size="sm" onClick={replay}>Replay</Button>}
          <Button variant="secondary" size="sm" onClick={close}>Done</Button>
        </> : <Button variant="ghost" size="sm" onClick={skip}>Skip</Button>}
      </div>
    </div>
  </motion.div>;
}
