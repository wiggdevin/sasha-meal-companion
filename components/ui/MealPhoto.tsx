"use client";

import { getImageProps } from "next/image";
import { mealArtAspect } from "@/lib/today/meal-art";
import styles from "@/components/ui/MealPhoto.module.css";

/**
 * A meal card's photo (cards v4): a flat-cornered box — the Focus card's full-width banner or a
 * compact card's left rail — that the card's own shell clips. The photo covers the box at its own
 * aspect, so it only ever scales evenly, never squashes. Without a photo the box shows the app's own
 * olive art, never a stranger's photo. The header no longer changes shape when a card opens, so the
 * photo no longer morphs.
 */
export default function MealPhoto({ src, className }: {
  src: string | null;
  /** The box (AfterDarkCards.module.css photo). */
  className: string;
}) {
  const aspect = src ? mealArtAspect(src) : 1;
  const image = src ? getImageProps({
    src, alt: "", width: 1100, height: Math.round(1100 / aspect), sizes: "(max-width: 640px) 90vw, 640px",
  }).props : null;
  const { srcSet, sizes, width, height, decoding, loading } = image ?? {};
  return <span aria-hidden="true" data-meal-photo={src ? "photo" : "art"} className={`${className} ${styles.clip}`}>
    {image && <img src={image.src} srcSet={srcSet} sizes={sizes} width={width} height={height}
      decoding={decoding} loading={loading} alt="" className={styles.cover}
      style={{ ["--a" as string]: aspect }} />}
  </span>;
}
