"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { FADES, INSTANT } from "@/lib/design/motion";
import type { PetMood } from "@/lib/today/pet-mood";
import styles from "@/components/today/island/SproutFigure.module.css";

/**
 * Sprout's poses: the four moods of the glass well, a wave for a first hello, and onboarding v2's
 * beats: listening (while the user speaks), thinking (while the app reads what was said) and pointing
 * (at a choice or an empty slot, toward the viewer's right).
 */
export type SproutPose = PetMood | "wave" | "listening" | "thinking" | "pointing";

/**
 * Hero-size art (768 px square, webp), cut from the 2k Higgsfield masters of the original renders
 * (docs/design/meal-card-image-sources.md) and framed in one shared square, so changing the pose
 * never moves or resizes the pet. The well's own 384 px art (PET_ART) is unchanged.
 */
export const SPROUT_HERO_ART: Record<SproutPose, string> = {
  content: "/pet/hero/sprout-content.webp",
  joyful: "/pet/hero/sprout-joyful.webp",
  sleepy: "/pet/hero/sprout-sleepy.webp",
  droopy: "/pet/hero/sprout-droopy.webp",
  wave: "/pet/hero/sprout-wave.webp",
  listening: "/pet/hero/sprout-listening.webp",
  thinking: "/pet/hero/sprout-thinking.webp",
  pointing: "/pet/hero/sprout-pointing.webp",
};

/**
 * Sprout on its own, at any size: for onboarding's guide and any full-screen moment (2026-10-07,
 * onboarding v2). Presentational only: no mood is read here and nothing is stored. It breathes on a
 * slow loop and stands on a soft contact shadow; a pose change cross-fades in place. Reduced motion
 * holds it still and swaps poses at once. Decorative unless `label` is given, then it is one image
 * with that name.
 */
export function SproutFigure({ mood, size = 240, label, breathe = true, shadow = true, priority = false,
  className = "", children }: {
  mood: SproutPose;
  /** Rendered width and height, px. The art is 768 px, so it stays sharp up to 384 px at 2x. */
  size?: number;
  label?: string;
  breathe?: boolean;
  shadow?: boolean;
  /** Load the art eagerly (above the fold on a first screen). */
  priority?: boolean;
  className?: string;
  /** Layers worn over this pose (DressedSprout): inside its frame, so they breathe and cross-fade with it. */
  children?: ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  return <span className={`${styles.figure} ${className}`} style={{ width: size, height: size }}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-pose={mood}>
    {shadow && <span aria-hidden="true" className={styles.shadow} data-still={reduce || !breathe || undefined} />}
    <span className={styles.breath} data-still={reduce || !breathe || undefined}>
      <AnimatePresence initial={false}>
        <motion.span key={mood} className={styles.frame} initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
          <Image src={SPROUT_HERO_ART[mood]} alt="" fill sizes={`${size}px`} priority={priority} draggable={false}
            className={styles.img} />
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  </span>;
}
