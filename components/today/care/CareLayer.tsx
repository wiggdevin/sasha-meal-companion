"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import AwardPlayer from "@/components/today/care/AwardPlayer";
import CareNotes, { nextNote } from "@/components/today/care/CareNotes";
import CareShop, { type ShopRules } from "@/components/today/care/shop/CareShop";
import type { Award } from "@/components/today/care/awards";
import { equipCareItem, markAccoladesSeen, markCareMessage, offeredItems, purchaseCareItem } from "@/components/today/care/care-api";
import { seeds } from "@/components/today/care/shop/shop-state";
import { unlockAudio } from "@/components/today/care/sound";
import { useCare, type CareData } from "@/components/today/care/useCare";
import { FADES, INSTANT } from "@/lib/design/motion";
import { localIsoDate } from "@/lib/settings/date";
import { named } from "@/components/today/island/mascots";
import { useMascot } from "@/components/today/island/well-pet";
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
 * A panel over the well made modal while `open`: everything outside it inert, and Tab / Shift+Tab
 * wrapping inside it. Shared by the shop and the award player.
 */
function useModal(box: RefObject<HTMLElement | null>, open: boolean, homes: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    const el = box.current;
    if (!open || !el) return;
    const undo = inertOutside(el);
    const release = () => {
      undo();
      // Released after the panel's exit: if focus was left on the page (or in the panel that left),
      // it goes home (the chip, else this layer).
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected || el.contains(at)) {
        homes.map((ref) => ref.current).find((target) => target?.isConnected)?.focus({ preventScroll: true });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const stops = [...el.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, [tabindex]:not([tabindex='-1'])")]
        .filter((stop) => !stop.closest("[inert]"));
      if (!stops.length) { event.preventDefault(); return; }
      const first = stops[0]; const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (event.shiftKey && (at === first || !el.contains(at) || !stops.includes(at as HTMLElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (at === last || !el.contains(at))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); release(); };
    // `homes` is a fresh array each render; its refs are stable, so it is read at release only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, open]);
}

/**
 * Seeds, the shop and Sprout's messages on the companion's open stage on today (owner, 2026-10-07; the care
 * backend, #5). A small Seeds chip sits in the card's lower corner and opens the shop over the well;
 * the newest message drops in at the top (an award offers Watch, which plays it and marks it seen);
 * Escape or Close puts the shop away and hands focus back to the chip. The shop and the award
 * player are modal while open, and no tap inside this layer reaches the well behind it (it would
 * fold, swipe or long-press the card). Nothing shows until the server
 * answers, and nothing at all when it cannot: a failed read is quiet, never a guessed balance.
 */
export default function CareLayer({ active, notesAt = "top", care: given, modalAt = "card" }: {
  active: boolean;
  /** Where the shop and the award player open: over this layer's box, or over the whole screen
   *  (the companion row's stage is too small to hold them). */
  modalAt?: "card" | "screen";
  /** The owner's own care read (the companion row reads it once for its Seeds tag and this layer). */
  care?: CareData;
  /** Where messages drop in: "bottom" in a view whose top strip holds its own controls (water). */
  notesAt?: "top" | "bottom";
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const mascot = useMascot();
  const own = useCare(given ? false : active);
  const care = given ?? own;
  const [shopOpen, setShopOpen] = useState(false);
  const [award, setAward] = useState<{ award: Award; message: string } | null>(null);
  const chip = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const note = nextNote(care.notes);

  // The shop shows only while there is a shop to show.
  const open = shopOpen && care.shop !== null;
  const awardBox = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  // A closing panel stays modal through its exit (the fade), then hands focus home.
  const [shopLeaving, setShopLeaving] = useState(false);
  const [awardLeaving, setAwardLeaving] = useState(false);
  useModal(panel, open || shopLeaving, [chip, root]);
  useModal(awardBox, award !== null || awardLeaving, [chip, root]);
  const closeShop = () => { setShopOpen(false); setShopLeaving(true); };
  useEffect(() => {
    if (!open) return;
    // Focus moves into the shop; Escape puts it away.
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setShopOpen(false); setShopLeaving(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // The well folded or moved off today: whatever was open leaves.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!active) { setShopOpen(false); setAward(null); }
  }, [active]);

  if (!active) return null;
  const shop = care.shop;
  return <div ref={root} className={styles.layer} tabIndex={-1}
    onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    {!open && !award && <CareNotes note={note} mascot={mascot} place={notesAt}
      onWatch={(next) => {
        unlockAudio();
        // The Watch button leaves with its note: hand focus to something that stays (the chip, else
        // this layer), so the award player returns it there when it closes.
        (chip.current ?? root.current)?.focus({ preventScroll: true });
        if (note) { care.drop(note.id); setAward({ award: next, message: note.id }); }
      }}
      onDismiss={(id) => {
        const gone = care.notes.find((n) => n.id === id);
        care.drop(id);
        // "Later" on an award keeps it for next time; closing any other note dismisses it for good.
        if (gone && gone.type !== "accolade") void markCareMessage(id, "dismiss");
      }} />}
    {shop && <button ref={chip} type="button" className={`tap ${styles.chip}`} onClick={() => setShopOpen(true)} inert={open}
      aria-label={named(`${seeds(shop.state.balance)}. Open Sprout's shop`, mascot)}>
      <svg className={styles.seed} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M8 1.5c3 2.2 4.6 5 4.6 7.6A4.6 4.6 0 0 1 8 13.7a4.6 4.6 0 0 1-4.6-4.6C3.4 6.5 5 3.7 8 1.5Z" />
      </svg>
      <span>{shop.state.balance.toLocaleString("en-US")}</span>
    </button>}
    <AnimatePresence onExitComplete={() => setShopLeaving(false)}>
      {shop && open && <motion.div ref={panel} key="shop" role="dialog" aria-modal="true" aria-label={named("Sprout's shop", mascot)} tabIndex={-1}
        className={`matte ${styles.panel}`} data-screen={modalAt === "screen" || undefined}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? INSTANT : FADES.base}>
        <CareShop state={shop.state} today={localIsoDate(new Date())} rules={SERVER} items={offeredItems(shop.prices)}
          onChange={(next) => care.setShop({ ...shop, state: next })} onRefresh={care.refresh} onClose={closeShop} />
      </motion.div>}
    </AnimatePresence>
    <div ref={awardBox} className={award && modalAt === "screen" ? styles.screen : undefined}>
    <AnimatePresence onExitComplete={() => setAwardLeaving(false)}>
      {award && <AwardPlayer key={award.message} award={award.award} modal onClose={() => {
        void markAccoladesSeen([award.award.key]);
        void markCareMessage(award.message, "read");
        setAward(null);
        setAwardLeaving(true);
      }} />}
    </AnimatePresence>
    </div>
  </div>;
}
