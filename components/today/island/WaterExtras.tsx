"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { SPRINGS } from "@/lib/design/motion";
import type { Jet } from "@/components/today/island/water-dye";
import styles from "@/components/today/island/WellWater.module.css";
import { sceneArt } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";

/** Where things are in the basin, as fractions of its width and height. */
export const BUCKET = { x: 0.41, y: 0.03, w: 0.18 } as const;
/** The bucket's mouth when tipped, in the basin (fractions): the cup's water pours from here. */
export const SPOUT = { x: 0.57, y: 0.25 } as const;
const POUR_MS = 1300;
/** The inks follow the bucket: the droppers poke in at the walls, then squirt for INK_MS. */
export const INK_AFTER_MS = 1150;
export const INK_MS = 1300;
/** How far the dropper sits from the wall it slides in over, as a fraction of its own length. */
const DROPPER_OUT = 0.75;
/** The dropper's length as a fraction of the basin's width (matches `.dropper` in the CSS). */
const DROPPER_WIDTH = 0.26;
/** How far under the surface the tip sits, px (about 0.09 of the water body at the goal). */
const TIP_DEPTH_PX = 12;
/**
 * The two inks: a glass dropper over each side wall, its tip just under the surface, angled down and
 * toward the middle; the second starts a beat after the first, so the jets meet and curl round each
 * other. Each jet starts at its dropper's tip and leaves along the dropper (`angle`, degrees below
 * level). The angle and the tip keep the glass clear of the readout and the button above the water.
 * `jet` positions are fractions of the water body (row 0 at the surface).
 */
export const INKS: { src: string; side: "left" | "right"; angle: number; jet: Omit<Jet, "left"> }[] = [
  { src: "/pet/water/dropper-orange.webp", side: "left", angle: 40,
    jet: { x: 0.08, y: 0.09, dx: Math.cos(Math.PI * 40 / 180), dy: Math.sin(Math.PI * 40 / 180), speed: 120, ink: 4.5, channel: "a" } },
  { src: "/pet/water/dropper-plum.webp", side: "right", angle: 35,
    jet: { x: 0.92, y: 0.09, dx: -Math.cos(Math.PI * 35 / 180), dy: Math.sin(Math.PI * 35 / 180), speed: 120, ink: 4.5, channel: "b", wait: 0.35 } },
];

/**
 * Who pours (owner, 2026-10-07: "Sprout could literally have a little bucket that he starts pouring
 * out"): for each cup added Sprout slides in at the top of the basin with a wooden bucket, tips it so
 * the water falls from its mouth (WellWater spawns the drops at SPOUT), and slides away. Near the goal
 * (80 % and up) two glass droppers then slide in over the side walls and squirt their inks into the
 * clear water (water-dye.ts carries them). Decorative: the cup figure says it in words.
 */
export default function WaterExtras({ pours, dyes, surface }: {
  /** Counts up once per cup added. */
  pours: number;
  /** Counts up once per ink squirt. */
  dyes: number;
  /** The water's surface, as a fraction of the basin's height from the top. */
  surface: number;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  const [pouring, setPouring] = useState<"none" | "hold" | "pour">("none");
  const [inking, setInking] = useState(false);

  useEffect(() => {
    if (!pours || reduce) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPouring("hold");
    const tip = setTimeout(() => setPouring("pour"), 280);
    const back = setTimeout(() => setPouring("hold"), 280 + POUR_MS - 360);
    const away = setTimeout(() => setPouring("none"), 280 + POUR_MS);
    return () => { clearTimeout(tip); clearTimeout(back); clearTimeout(away); };
  }, [pours, reduce]);

  useEffect(() => {
    if (!dyes || reduce) return;
    const show = setTimeout(() => setInking(true), INK_AFTER_MS - 350);
    const hide = setTimeout(() => setInking(false), INK_AFTER_MS + INK_MS + 450);
    return () => { clearTimeout(show); clearTimeout(hide); };
  }, [dyes, reduce]);

  // Reduced motion switched on mid-pour: the actors leave at once rather than freeze on screen.
  useEffect(() => {
    if (!reduce) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPouring("none");
    setInking(false);
  }, [reduce]);

  return <div aria-hidden="true" className={styles.extras}>
    <AnimatePresence>
      {pouring !== "none" && <motion.span key="bucket" className={styles.bucket}
        style={{ left: `${BUCKET.x * 100}%`, top: `${BUCKET.y * 100}%`, width: `${BUCKET.w * 100}%` }}
        initial={{ y: "-110%", opacity: 0 }} animate={{ y: "0%", opacity: 1 }} exit={{ y: "-110%", opacity: 0 }}
        transition={SPRINGS.snappy}>
        <Image src={sceneArt(mascot, pouring === "pour" ? "bucket-pour" : "bucket-hold")} alt="" width={313} height={360}
          sizes="70px" draggable={false} />
      </motion.span>}
    </AnimatePresence>
    <AnimatePresence>
      {inking && INKS.map((ink) => {
        // The outer box turns about the dropper's tip, which sits at the jet's start; the inner image
        // slides along the dropper's own length, so it pokes in and draws back along its axis.
        const left = ink.side === "left" ? `${(ink.jet.x - DROPPER_WIDTH) * 100}%` : `${ink.jet.x * 100}%`;
        const out = `${(ink.side === "left" ? -1 : 1) * DROPPER_OUT * 100}%`;
        return <span key={ink.src} className={styles.dropper} data-side={ink.side}
          style={{ left, top: `calc(${surface * 100}% + ${TIP_DEPTH_PX}px)`, rotate: `${ink.side === "left" ? ink.angle : -ink.angle}deg` }}>
          <motion.span className={styles.dropperSlide} initial={{ x: out, opacity: 0 }}
            animate={{ x: "0%", opacity: 1 }} exit={{ x: out, opacity: 0 }} transition={SPRINGS.smooth}>
            <Image src={ink.src} alt="" width={480} height={101} sizes="120px" draggable={false} />
          </motion.span>
        </span>;
      })}
    </AnimatePresence>
  </div>;
}
