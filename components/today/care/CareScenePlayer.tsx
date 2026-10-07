"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import Sparks, { type SparksApi } from "@/components/today/care/Sparks";
import { play, readMuted, silence, unlockAudio } from "@/components/today/care/sound";
import type { CareScene } from "@/components/today/care/shop/catalog";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import awards from "@/components/today/care/Awards.module.css";
import styles from "@/components/today/care/Care.module.css";

/** Each care scene: its two frames (during, after) and its words. Copy observes; it never instructs. */
const SCENES: Record<CareScene, { during: string; after: string; title: string; doing: string; line: string }> = {
  massage: { during: "/pet/care/massage-1.webp", after: "/pet/care/massage-2.webp", title: "Massage",
    doing: "Sprout is having a massage.", line: "Sprout feels brand new." },
};
/** The scene, ms: relaxing on the table, then sitting up glowing, then the words. */
const AFTER_MS = 3800;
const WORDS_MS = 4300;
const HEARTS = [{ x: 0.36, at: 0.9 }, { x: 0.6, at: 1.7 }, { x: 0.46, at: 2.5 }];
const WISPS = [{ x: 0.3, delay: 0 }, { x: 0.52, delay: 0.9 }, { x: 0.7, delay: 1.8 }];

/**
 * A care scene, played inside the open well (owner, 2026-10-07: "a shop with items … massage"; GPT-6
 * Astra §5, care scenes). The room dims warm; Sprout lies on a tiny spa table under warm stones,
 * breathing slow while steam drifts and small hearts rise; then it sits up glowing, a few sparks and a
 * soft plink, and the words rise. Replay runs it again; Done or Escape closes it and hands focus back.
 * Reduced motion shows the finished frame and its words, with no motion and no sound; the sound
 * follows the shared Sound off. A panel inside the card, like the award player.
 */
export default function CareScenePlayer({ scene, onClose }: { scene: CareScene; onClose: () => void }) {
  const reduce = useReducedMotionConfig() ?? false;
  const art = SCENES[scene];
  const sparks = useRef<SparksApi | null>(null);
  const self = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const home = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const [run, setRun] = useState(0);
  const [step, setStep] = useState<"during" | "after" | "done">("during");
  // Reduced motion shows the finished frame and its words, whatever the timeline says.
  const phase = reduce ? "done" : step;
  // The after/words timeouts, so Done and Escape can cancel them the moment the user asks to close —
  // the panel keeps playing its exit fade for a beat after that (AnimatePresence), and a timeout left
  // running through that fade would still flip the phase and fire the plink after Done was pressed.
  const timers = useRef<{ after?: ReturnType<typeof setTimeout>; words?: ReturnType<typeof setTimeout> }>({});
  const clearTimers = () => { clearTimeout(timers.current.after); clearTimeout(timers.current.words); };

  // In the commit of the tap that opened the scene: the browser lets sound start here.
  useLayoutEffect(() => { if (!reduce && !readMuted()) unlockAudio(); }, [reduce]);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    home.current = self.current?.parentElement ?? null;
    self.current?.focus({ preventScroll: true });
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); clearTimers(); silence(); onCloseRef.current(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      silence();
      document.removeEventListener("keydown", onKey);
      const back = opener.current?.isConnected ? opener.current : home.current;
      back?.focus?.({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (reduce) return;
    timers.current.after = setTimeout(() => {
      setStep("after");
      sparks.current?.burst(175, 200, 14);
      if (!readMuted()) play("plink");
    }, AFTER_MS);
    timers.current.words = setTimeout(() => setStep("done"), WORDS_MS);
    return clearTimers;
  }, [run, reduce]);

  const relaxed = phase === "during";
  const close = () => { clearTimers(); silence(); onClose(); };
  return <motion.div ref={self} role="dialog" aria-label={`Care: ${art.title}`} tabIndex={-1}
    className={`matte ${awards.player}`} data-material="wood"
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
    <div aria-hidden="true" className={awards.dim} />
    <div aria-hidden="true" className={styles.stage} key={run}>
      {relaxed && WISPS.map((wisp, i) => <motion.span key={`w${i}`} className={styles.wisp} style={{ left: `${wisp.x * 100}%` }}
        initial={{ opacity: 0, y: 0, scale: 0.8 }} animate={{ opacity: [0, 0.7, 0], y: -70, scale: 1.4 }}
        transition={{ duration: 2.6, delay: wisp.delay, repeat: Infinity, repeatDelay: 0.4, ease: "easeOut" }} />)}
      {/* Both frames stay mounted (both load up front) and cross-fade: relaxing, then sitting up. */}
      <motion.span className={styles.frame} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        animate={relaxed ? { opacity: 1, scale: [1, 1.012, 1], scaleY: [1, 0.982, 1] } : { opacity: 0, scale: 1, scaleY: 1 }}
        transition={relaxed ? { opacity: SPRINGS.smooth, scale: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
          scaleY: { duration: 2.4, repeat: Infinity, ease: "easeInOut" } } : reduce ? INSTANT : SPRINGS.smooth}>
        <Image src={art.during} alt="" fill sizes="320px" priority className={styles.art} draggable={false} />
      </motion.span>
      {/* Reduced motion: the finished frame is simply there, no fade and no settle. */}
      <motion.span className={styles.frame} initial={reduce ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96 }}
        animate={relaxed ? { opacity: 0, scale: 0.96 } : { opacity: 1, scale: 1 }}
        transition={relaxed || reduce ? INSTANT : SPRINGS.bouncy}>
        <Image src={art.after} alt="" fill sizes="320px" priority className={styles.art} draggable={false} />
      </motion.span>
      {relaxed && HEARTS.map((heart, i) => <motion.svg key={`h${i}`} className={styles.heart} viewBox="0 0 16 16"
        style={{ left: `${heart.x * 100}%` }} initial={{ opacity: 0, y: 0, scale: 0.6 }}
        animate={{ opacity: [0, 1, 0], y: -60, scale: 1 }} transition={{ duration: 1.6, delay: heart.at, ease: "easeOut" }}>
        <path d="M8 14s-5.5-3.4-5.5-7.2A3 3 0 0 1 8 5a3 3 0 0 1 5.5 1.8C13.5 10.6 8 14 8 14Z" />
      </motion.svg>)}
    </div>
    <Sparks ref={sparks} still={reduce} />
    <AnimatePresence>
      {phase === "done" && <motion.div key="words" className={awards.words}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <p className={awards.title}>{art.title}</p>
        <p className={awards.line}>{art.line}</p>
      </motion.div>}
    </AnimatePresence>
    <p className="sr-only" aria-live="polite">{phase === "done" ? `${art.title}. ${art.line}` : art.doing}</p>
    <div className={awards.controls}>
      <span />
      <div>
        {phase === "done" && !reduce && <Button variant="ghost" size="sm" onClick={() => { setStep("during"); setRun((n) => n + 1); }}>Replay</Button>}
        <Button variant="secondary" size="sm" onClick={close}>Done</Button>
      </div>
    </div>
  </motion.div>;
}
