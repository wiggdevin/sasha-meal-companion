"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimationControls, useIsPresent, useReducedMotionConfig } from "motion/react";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import type { PetState, PetWhen } from "@/lib/today/pet-mood";
import { MASCOTS, type MascotKey } from "@/components/today/island/mascots";
import { wellArt } from "@/components/today/island/well-pet";
import styles from "@/components/today/island/Sprout.module.css";
import TourOffer from "@/components/tour/TourOffer";

/** Sprout alone at any size (onboarding v2's guide); see SproutFigure.tsx. */
export { SPROUT_HERO_ART, SproutFigure, type SproutPose } from "@/components/today/island/SproutFigure";

/** Where the user last touched the well, so Sprout can look that way. */
export type Glance = { x: number; key: number } | null;

/** A hop on the house springs: squash on the snappy one, then the bouncy one throws it up and settles. */
async function hopOnce(hop: ReturnType<typeof useAnimationControls>) {
  await hop.start({ scaleX: 1.07, scaleY: 0.9, y: 2 }, SPRINGS.snappy);
  await hop.start({ scaleX: 0.95, scaleY: 1.06, y: -12 }, SPRINGS.snappy);
  await hop.start({ scaleX: 1, scaleY: 1, y: 0 }, SPRINGS.bouncy);
}

/**
 * The band Sprout's stage lives in above the open island: it springs to its content's own height (so
 * larger text never clips it) and, while it leaves, is inert — out of the tab order and hidden from
 * assistive tech — handing focus back if it held it.
 */
export function SproutBand({ className, onLeave, children }: { className: string; onLeave: () => void; children: ReactNode }) {
  const reduce = useReducedMotionConfig() ?? false;
  const present = useIsPresent();
  const self = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!present && self.current?.contains(document.activeElement)) onLeave();
  }, [present, onLeave]);
  return <motion.div ref={self} className={className} inert={!present} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
    animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
    exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
    transition={reduce ? INSTANT : { height: SPRINGS.bouncy, opacity: { ...FADES.base, delay: 0.06 } }}>
    {children}
  </motion.div>;
}

/** Collapsed: the whole of Sprout, small, standing at the island's head on its own light. Decorative. */
export function SproutMini({ state, mascot = "sprout" }: { state: PetState; mascot?: MascotKey }) {
  return <span aria-hidden="true" className={styles.mini} data-mood={state.mood}>
    <span className={styles.miniShadow} />
    <span className={styles.miniBreath}>
      <Image src={wellArt(mascot, state.mood)} alt="" width={42} height={42} sizes="42px" draggable={false}
        className={styles.img} />
    </span>
  </span>;
}

/**
 * Expanded: Sprout standing in the well's liquid (owner, 2026-10-06; Kimi K3 and Gemini 3.1 Pro
 * design passes). It breathes, its contact shadow and its wet reflection breathe with it, it leans
 * toward where the user touched the well, and it hops when tapped or when a cup is added. A tap also
 * says hello back in its line, so the press answers without motion and for a screen reader. Its mood
 * and the vitality bar come from lib/today/pet-mood.ts. The glass lid's sheen passes over it.
 */
export default function SproutStage({ state, glance, bounce, when = "today", figureOnly = false, mascot = "sprout" }: {
  state: PetState; glance: Glance; bounce: number; when?: PetWhen;
  /** The chosen companion (Settings.mascot): whose art and name the well shows. */
  mascot?: MascotKey;
  /** In the middle of the rings: the figure only; the name, line and meter stay for screen readers. */
  figureOnly?: boolean;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const self = useRef<HTMLButtonElement | null>(null);
  const [look, setLook] = useState(0);
  const [hello, setHello] = useState(0);
  const [taps, setTaps] = useState(0);
  const hop = useAnimationControls();

  useEffect(() => {
    if (!hello) return;
    const timer = setTimeout(() => setHello(0), 2400);
    return () => clearTimeout(timer);
  }, [hello]);

  useEffect(() => {
    if (!glance || reduce || !self.current) return;
    const box = self.current.getBoundingClientRect();
    setLook(Math.max(-1, Math.min(1, (glance.x - (box.left + box.width / 2)) / 120)));
    const timer = setTimeout(() => setLook(0), 2400);
    return () => clearTimeout(timer);
  }, [glance, reduce]);

  useEffect(() => {
    if (bounce > 0 && !reduce) void hopOnce(hop);
  }, [bounce, hop, reduce]);

  const vitality = state.vitality === null ? null : Math.round(state.vitality * 100);
  const name = MASCOTS[mascot].name;
  const art = wellArt(mascot, state.mood);
  return <div className={styles.stage} data-mood={state.mood}>
    {/* A tap says hello and offers the app overview beside the pet (components/tour). */}
    <button ref={self} type="button" className={`tap ${styles.pet}`} aria-label={`${name}. Say hello`}
      onClick={() => { setHello((count) => count + 1); setTaps((count) => count + 1); if (!reduce) void hopOnce(hop); }}>
      <span aria-hidden="true" className={styles.shadow} data-still={reduce || undefined} />
      <span aria-hidden="true" className={styles.reflection} data-still={reduce || undefined}>
        <Image src={art} alt="" fill sizes="104px" draggable={false} className={styles.img} />
      </span>
      <motion.span className={styles.lean} initial={false} animate={{ rotate: look * 6, x: look * 4 }}
        transition={reduce ? INSTANT : SPRINGS.smooth}>
        <motion.span className={styles.hop} animate={hop}>
          <span className={styles.breath} data-still={reduce || undefined}>
            <AnimatePresence initial={false}>
              <motion.span key={`${mascot}-${state.mood}`} className={styles.frame} initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
                <Image src={art} alt="" fill sizes="104px" draggable={false} className={styles.img} />
              </motion.span>
            </AnimatePresence>
          </span>
        </motion.span>
      </motion.span>
    </button>
    {figureOnly && <TourOffer shown={taps} origin={() => self.current} floating />}
    <div className={figureOnly ? "sr-only" : styles.status}>
      <span className={styles.name}>{name}</span>
      <span className={styles.line} aria-live="polite">{hello ? `${name} says hello back.` : state.line}</span>
      {!figureOnly && <TourOffer shown={taps} origin={() => self.current} />}
      {vitality !== null && <>
        <span aria-hidden="true" className={styles.meterRow}>
          <span>{when === "past" ? "Care that day" : "Care today"}</span><span>{vitality}%</span>
        </span>
        <span role="meter" aria-label={`${name}'s wellbeing`} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={vitality} aria-valuetext={`${vitality} percent`} className={styles.meter}
          data-band={vitality < 34 ? "low" : vitality < 67 ? "mid" : "high"}>
          <motion.span className={styles.meterFill} initial={false} animate={{ width: `${Math.max(8, vitality)}%` }}
            transition={reduce ? INSTANT : SPRINGS.bouncy} />
        </span>
      </>}
    </div>
  </div>;
}
