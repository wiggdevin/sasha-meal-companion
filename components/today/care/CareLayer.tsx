"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import AwardPlayer from "@/components/today/care/AwardPlayer";
import CareNotes, { nextNote } from "@/components/today/care/CareNotes";
import CareShop, { type ShopRules } from "@/components/today/care/shop/CareShop";
import type { Award } from "@/components/today/care/awards";
import { equipCareItem, markAccoladesSeen, markCareMessage, offeredItems, purchaseCareItem } from "@/components/today/care/care-api";
import { seeds } from "@/components/today/care/shop/shop-state";
import { unlockAudio } from "@/components/today/care/sound";
import { useCare } from "@/components/today/care/useCare";
import { FADES, INSTANT } from "@/lib/design/motion";
import styles from "@/components/today/care/CareLayer.module.css";

const SERVER: ShopRules = { purchase: purchaseCareItem, equip: equipCareItem };
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/**
 * Seeds, the shop and Sprout's messages in the open well on today (owner, 2026-10-07; the care
 * backend, #5). A small Seeds chip sits in the card's lower corner and opens the shop over the well;
 * the newest message drops in at the top (an award offers Watch, which plays it and marks it seen);
 * Escape or Close puts the shop away and hands focus back to the chip. Nothing shows until the server
 * answers, and nothing at all when it cannot: a failed read is quiet, never a guessed balance.
 */
export default function CareLayer({ active }: { active: boolean }) {
  const reduce = useReducedMotionConfig() ?? false;
  const care = useCare(active);
  const [shopOpen, setShopOpen] = useState(false);
  const [award, setAward] = useState<{ award: Award; message: string } | null>(null);
  const chip = useRef<HTMLButtonElement | null>(null);
  const note = nextNote(care.notes);

  useEffect(() => {
    if (!shopOpen) return;
    // The chip stays mounted under the shop, so focus can go straight back to it on close.
    const opener = chip.current;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setShopOpen(false); } };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); opener?.focus({ preventScroll: true }); };
  }, [shopOpen]);
  // The well folded or moved off today: whatever was open leaves.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!active) { setShopOpen(false); setAward(null); }
  }, [active]);

  if (!active) return null;
  const shop = care.shop;
  return <div className={styles.layer}>
    {!shopOpen && !award && <CareNotes note={note}
      onWatch={(next) => {
        unlockAudio();
        if (note) { care.drop(note.id); setAward({ award: next, message: note.id }); }
      }}
      onDismiss={(id) => {
        const gone = care.notes.find((n) => n.id === id);
        care.drop(id);
        // "Later" on an award keeps it for next time; closing any other note dismisses it for good.
        if (gone && gone.type !== "accolade") void markCareMessage(id, "dismiss");
      }} />}
    {shop && <button ref={chip} type="button" className={`tap ${styles.chip}`} onClick={() => setShopOpen(true)} inert={shopOpen}
      aria-label={`${seeds(shop.state.balance)}. Open Sprout's shop`}>
      <svg className={styles.seed} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M8 1.5c3 2.2 4.6 5 4.6 7.6A4.6 4.6 0 0 1 8 13.7a4.6 4.6 0 0 1-4.6-4.6C3.4 6.5 5 3.7 8 1.5Z" />
      </svg>
      <span>{shop.state.balance.toLocaleString("en-US")}</span>
    </button>}
    <AnimatePresence>
      {shop && shopOpen && <motion.div key="shop" role="dialog" aria-label="Sprout's shop" className={`matte ${styles.panel}`}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
        <CareShop state={shop.state} today={localDate()} rules={SERVER} items={offeredItems(shop.prices)}
          onChange={(next) => care.setShop({ ...shop, state: next })} onRefresh={care.refresh} onClose={() => setShopOpen(false)} />
      </motion.div>}
    </AnimatePresence>
    <AnimatePresence>
      {award && <AwardPlayer key={award.message} award={award.award} onClose={() => {
        void markAccoladesSeen([award.award.key]);
        void markCareMessage(award.message, "read");
        setAward(null);
      }} />}
    </AnimatePresence>
  </div>;
}
