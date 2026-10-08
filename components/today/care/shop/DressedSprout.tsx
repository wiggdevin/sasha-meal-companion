"use client";

import Image from "next/image";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import { SproutFigure } from "@/components/today/island/SproutFigure";
import { SLOTS, SPROUT_LEAF, itemById, type Place, type ShopItem, type Slot } from "@/components/today/care/shop/catalog";
import styles from "@/components/today/care/shop/Shop.module.css";
import type { MascotKey } from "@/components/today/island/mascots";

/** The content pose's art is 768 px square; every place is in its pixels. */
const ART = 768;

/** A part's box in the frame, as percentages, so it scales with Sprout at any size. */
function box(place: Place, aspect: number) {
  const h = place.w / aspect;
  return {
    left: `${((place.x - place.w / 2) / ART) * 100}%`,
    top: `${((place.y - h / 2) / ART) * 100}%`,
    width: `${(place.w / ART) * 100}%`,
    rotate: `${place.rotate ?? 0}deg`,
    scale: place.mirror ? "-1 1" : undefined,
  };
}

function Part({ item, place, size }: { item: ShopItem; place: Place; size: number }) {
  return <span className={styles.part} style={box(place, item.aspect)}>
    <Image src={item.art} alt="" width={384} height={Math.round(384 / item.aspect)}
      sizes={`${Math.ceil((place.w / ART) * size)}px`} draggable={false} className={styles.partImg} />
  </span>;
}

/**
 * Sprout wearing what it has on (owner, 2026-10-07: items "for the mascot"; GPT-6 Astra §5: painted
 * layers anchored on the pose, never a Sprout re-drawn per outfit). Each part sits inside the figure's
 * frame, so it breathes with Sprout. A new part drops on with the bouncy spring and settles; a part
 * taken off lifts away. Shorts are clipped to Sprout's own outline, and the leaf is drawn again over a
 * hat so the sprout grows through it. Only the content pose has anchors so far.
 */
export default function DressedSprout({ wearing, size = 200, label, mascot = "sprout" }: {
  /** What is on, by slot: equipped items and one being tried on. */
  wearing: Readonly<Partial<Record<Slot, string>>>;
  size?: number;
  label?: string;
  /** The companion to draw. The wearables are painted for Sprout's shape, so only Sprout wears them for now. */
  mascot?: MascotKey;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const items = mascot !== "sprout" ? [] : SLOTS.map(({ slot }) => wearing[slot]).map((id) => (id ? itemById(id) : undefined))
    .filter((item): item is ShopItem => Boolean(item));
  const hat = items.some((item) => item.underLeaf);
  return <SproutFigure mood="content" size={size} label={label} mascot={mascot}>
    <AnimatePresence initial={false}>
      {items.map((item) => <motion.span key={item.id} className={item.clipToBody ? `${styles.layer} ${styles.bodyClip}` : styles.layer}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: "-6%", scale: 1.06 }} animate={{ opacity: 1, y: "0%", scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-5%" }} transition={reduce ? INSTANT : SPRINGS.bouncy}>
        {item.places.map((place, i) => <Part key={i} item={item} place={place} size={size} />)}
      </motion.span>)}
    </AnimatePresence>
    {hat && <span className={styles.layer} aria-hidden="true">
      <Image src={SPROUT_LEAF} alt="" fill sizes={`${size}px`} draggable={false} className={styles.leaf} />
    </span>}
  </SproutFigure>;
}
