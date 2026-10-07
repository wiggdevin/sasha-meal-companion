"use client";

import { getImageProps } from "next/image";
import { motion, type Transition } from "motion/react";
import { mealArtAspect } from "@/lib/today/meal-art";
import styles from "@/components/ui/MealPhoto.module.css";

/**
 * A meal card's photo, built to change shape (2026-10-01, the meal card's container transform). The
 * clip is the box the card's layout gives it (the full-width top of a featured card, the left of a
 * compact one) and morphs between them with its sweeping corner; the photo inside always covers the
 * clip at its own aspect, so while the box stretches the food only ever scales evenly, never squashes.
 * Without a photo the clip shows the app's own olive art.
 */
export default function MealPhoto({ src, className, compact, transition }: {
  src: string | null;
  /** The clip's box (AfterDarkCards.module.css heroPhoto). */
  className: string;
  compact: boolean;
  transition: Transition;
}) {
  const aspect = src ? mealArtAspect(src) : 1;
  const image = src ? getImageProps({
    src, alt: "", width: 1100, height: Math.round(1100 / aspect), sizes: "(max-width: 640px) 90vw, 640px",
  }).props : null;
  const { srcSet, sizes, width, height, decoding, loading } = image ?? {};
  // The reference's sweep: a featured photo curves away at its lower right, a compact one at its upper right.
  const corners = compact ? { borderTopRightRadius: 44, borderBottomRightRadius: 0 } : { borderTopRightRadius: 0, borderBottomRightRadius: 72 };
  return <motion.span aria-hidden="true" data-meal-photo={src ? "photo" : "art"} className={`${className} ${styles.clip}`}
    layout layoutDependency={compact} initial={false} animate={corners} transition={transition}>
    {image && <motion.img src={image.src} srcSet={srcSet} sizes={sizes} width={width} height={height}
      decoding={decoding} loading={loading} alt="" className={styles.cover}
      style={{ ["--a" as string]: aspect }} layout layoutDependency={compact} transition={transition} />}
  </motion.span>;
}
