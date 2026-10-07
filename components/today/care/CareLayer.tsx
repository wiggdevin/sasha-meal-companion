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
import { localIsoDate } from "@/lib/settings/date";
import styles from "@/components/today/care/CareLayer.module.css";

const SERVER: ShopRules = { purchase: purchaseCareItem, equip: equipCareItem };

/**
 * Makes everything outside `el` inert (every ancestor's other children, up to the body) and returns
 * the undo, which restores only what it changed: the shop is modal, so neither a pointer nor the
 * keyboard reaches the rest of Today while it is open.
 */
function inertOutside(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling !== node && sibling instanceof HTMLElement && !sibling.inert) { sibling.inert = true; changed.push(sibling); }
    }
  }
  return () => { for (const sibling of changed) sibling.inert = false; };
}

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
  const panel = useRef<HTMLDivElement | null>(null);
  const note = nextNote(care.notes);

  // The shop shows only while there is a shop to show.
  const open = shopOpen && care.shop !== null;
  useEffect(() => {
    if (!open) return;
    // Focus moves into the shop, everything outside it goes inert, and on close both come back.
    const opener = chip.current;
    const undo = panel.current ? inertOutside(panel.current) : () => {};
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setShopOpen(false); return; }
      // A modal panel: Tab and Shift+Tab wrap inside the shop, never reaching the well behind it.
      const box = panel.current;
      if (event.key !== "Tab" || !box) return;
      const stops = [...box.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])")]
        .filter((el) => !el.closest("[inert]"));
      if (!stops.length) { event.preventDefault(); return; }
      const first = stops[0]; const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (event.shiftKey && (at === first || at === box || !box.contains(at))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (at === last || !box.contains(at))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { undo(); document.removeEventListener("keydown", onKey); opener?.focus({ preventScroll: true }); };
  }, [open]);
  // The well folded or moved off today: whatever was open leaves.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!active) { setShopOpen(false); setAward(null); }
  }, [active]);

  if (!active) return null;
  const shop = care.shop;
  return <div className={styles.layer}>
    {!open && !award && <CareNotes note={note}
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
    {shop && <button ref={chip} type="button" className={`tap ${styles.chip}`} onClick={() => setShopOpen(true)} inert={open}
      aria-label={`${seeds(shop.state.balance)}. Open Sprout's shop`}>
      <svg className={styles.seed} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M8 1.5c3 2.2 4.6 5 4.6 7.6A4.6 4.6 0 0 1 8 13.7a4.6 4.6 0 0 1-4.6-4.6C3.4 6.5 5 3.7 8 1.5Z" />
      </svg>
      <span>{shop.state.balance.toLocaleString("en-US")}</span>
    </button>}
    <AnimatePresence>
      {shop && open && <motion.div ref={panel} key="shop" role="dialog" aria-modal="true" aria-label="Sprout's shop" tabIndex={-1}
        className={`matte ${styles.panel}`}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
        <CareShop state={shop.state} today={localIsoDate(new Date())} rules={SERVER} items={offeredItems(shop.prices)}
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
