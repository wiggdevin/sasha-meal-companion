"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DOCK_CLEARANCE, springScrollIntoView, springScrollTo } from "@/lib/dom/spring-scroll";
import { LayoutGroup, motion, useReducedMotionConfig } from "motion/react";
import { FADES, INSTANT } from "@/lib/design/motion";
import AutoHeight from "@/components/ui/AutoHeight";
import SuggestionCard, { type SuggestionCardData } from "@/components/recipes-hub/SuggestionCard";

/** How long the open card's height must hold still before the dock clearance is checked again. */
const SETTLE_MS = 120;

export type CarouselItem = SuggestionCardData & {
  id: string;
  /** What the card shows once it has grown: the recipe, the meal's foods, the actions. */
  detail: ReactNode;
};

/**
 * A horizontal row of suggestion cards, one system for the Foods recipe hub, a meal card's Swap and a
 * menu's picks (2026-10-04). The row owns only the x axis (DESIGN.md §Layout, scroll ownership): it
 * snaps card by card, a vertical drag on it scrolls the page, and it bleeds to the edges of whatever
 * holds it.
 *
 * Tapping a card opens it in place (owner: "it should grow smoothly and take up the space provided so
 * the other smaller meal cards can just be pushed out of the way … some kind of visible X … and then
 * it should shrink back into the horizontal scroll"): the card grows to the row's full width on the
 * gentle spring while the row scrolls to sit it flush, so its neighbours slide off to either side;
 * the row stops scrolling while it is open, and grows to the card's height. × or Escape closes it:
 * the detail fades first, then the card shrinks back to its slot, the neighbours return and the row
 * is where it was. Focus moves into the open card and back to its button on close. Reduced motion:
 * every step is instant.
 */
export default function SuggestionCarousel({ items, label, nested = false, edge = "bleed", onOpenChange }: {
  items: CarouselItem[];
  /** The row's accessible name ("Meals to swap in", "Recipes"). */
  label: string;
  nested?: boolean;
  /** `bleed`: the row runs to the edges of the panel it sits in (16 px gutters). `tray`: it sits inside
   *  its own recessed tray with a 12 px inset. */
  edge?: "bleed" | "tray";
  onOpenChange?: (id: string | null) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [openId, setOpenId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const row = useRef<HTMLUListElement>(null);
  const savedScroll = useRef(0);
  const returnTo = useRef<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const cards = useRef(new Map<string, HTMLDivElement>());
  const open = items.find((item) => item.id === openId) ?? null;
  // The open card's option can leave the list (Swap rebuilds it once saved meals load): the row then
  // reads as closed at once, so no card stays pushed aside and inert (Sol review S3, 2026-10-04).
  const shownId = open ? openId : null;
  if (openId !== null && !open) {
    setOpenId(null);
    setShowDetail(false);
  }
  const notify = useRef(onOpenChange);
  useEffect(() => { notify.current = onOpenChange; }, [onOpenChange]);
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (told.current === shownId) return;
    // Focus that sat in the card that left falls back to the first card, not the page.
    const lost = told.current !== null && shownId === null && returnTo.current === null
      && (document.activeElement === document.body || document.activeElement === null);
    told.current = shownId;
    notify.current?.(shownId);
    if (lost) buttons.current.values().next().value?.focus({ preventScroll: true });
  }, [shownId]);
  const stopScroll = useRef<(() => void) | null>(null);
  useEffect(() => () => stopScroll.current?.(), []);

  function openCard(id: string) {
    savedScroll.current = row.current?.scrollLeft ?? 0;
    setOpenId(id);
    setShowDetail(true);
  }
  /** Content first: the detail fades, and only once it has gone does the card shrink (detailGone). */
  function closeCard() {
    if (!openId) return;
    returnTo.current = openId;
    if (showDetail && open?.detail) setShowDetail(false);
    else detailGone();
  }
  function detailGone() {
    setOpenId(null);
  }

  // In the same commit as the layout change, so the cards' layout animation runs from where they were
  // to where they land: open, the card sits flush at the row's start; closed, the row is back where it was.
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    if (openId) {
      const card = element.querySelector<HTMLElement>(`[data-carousel-id="${CSS.escape(openId)}"]`);
      const inset = parseFloat(getComputedStyle(element).paddingLeft) || 0;
      element.scrollLeft = card ? card.offsetLeft - inset : 0;
      cards.current.get(openId)?.focus({ preventScroll: true });
      // A grown card whose actions would sit under the dock comes up the screen on the same spring.
      if (card && card.getBoundingClientRect().bottom > window.innerHeight - DOCK_CLEARANCE) {
        stopScroll.current?.();
        stopScroll.current = springScrollIntoView(card, reduce);
      }
      return;
    }
    element.scrollLeft = savedScroll.current;
    const back = returnTo.current;
    returnTo.current = null;
    if (back) buttons.current.get(back)?.focus({ preventScroll: true });
  }, [openId, reduce]);

  // The first scroll runs before the gentle height spring has finished, so a tall card (an expanded
  // swap) could still end with "Swap to this" under the dock. Once the open card's height settles,
  // check again with the same clearance PanelReview uses, and move only as far as it must (never past
  // the card's top). Once per opening, so it never fights a person scrolling afterwards.
  useEffect(() => {
    if (!openId || typeof ResizeObserver === "undefined") return;
    const card = row.current?.querySelector<HTMLElement>(`[data-carousel-id="${CSS.escape(openId)}"]`);
    if (!card) return;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    // A person who scrolls, flicks or keys while the card opens has taken the page: no second scroll.
    let taken = false;
    const take = () => { taken = true; };
    const events = ["wheel", "touchmove", "keydown"] as const;
    events.forEach((name) => window.addEventListener(name, take, { passive: true }));
    const settle = () => {
      observer.disconnect();
      if (taken) return;
      const box = card.getBoundingClientRect();
      const over = Math.min(box.bottom - (window.innerHeight - DOCK_CLEARANCE), box.top);
      if (over <= 1) return;
      const root = document.scrollingElement ?? document.documentElement;
      stopScroll.current?.();
      stopScroll.current = springScrollTo(root.scrollTop + over, reduce);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(settle, SETTLE_MS);
    });
    observer.observe(card);
    return () => {
      clearTimeout(quiet); observer.disconnect();
      events.forEach((name) => window.removeEventListener(name, take));
    };
  }, [openId, reduce]);

  return <AutoHeight spring="gentle" className={`min-w-0 ${edge === "bleed" ? "-mx-4" : ""}`}>
    <LayoutGroup>
      {/* A horizontal scroller clips on y too, so its scrollport carries room for a card's focus
          ring and its drop shadow below; the matching negative margins keep the row where it was. */}
      <ul ref={row} role="list" aria-label={label} data-carousel-open={shownId ? "true" : undefined}
        className={`relative flex min-w-0 list-none snap-x snap-mandatory items-start gap-3 ${
          edge === "bleed" ? "scroll-px-4 -mt-1 -mb-6 px-4 pt-2 pb-7" : "scroll-px-3 -mb-4 px-3 pt-3 pb-7"} ${
          shownId ? "overflow-x-hidden" : "overflow-x-auto overscroll-x-contain"}`}>
        {items.map((item) => {
          const isOpen = item.id === shownId;
          const aside = shownId !== null && !isOpen;
          // The cards pushed aside fade as they slide off, and come back as the open one shrinks.
          return <motion.li key={item.id} data-carousel-id={item.id} aria-hidden={aside || undefined} inert={aside}
            initial={false} animate={{ opacity: aside ? 0 : 1 }} transition={reduce ? INSTANT : FADES.quick}
            className={`flex shrink-0 snap-start scroll-mt-4 ${isOpen ? "w-full" : "w-[11.5rem]"}`}>
            <SuggestionCard {...item} nested={nested} reduce={reduce} open={isOpen}
              showDetail={isOpen && showDetail}
              ref={(node) => { if (node) cards.current.set(item.id, node); else cards.current.delete(item.id); }}
              buttonRef={(node) => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id); }}
              onOpen={() => openCard(item.id)} onClose={closeCard} onDetailGone={detailGone} />
          </motion.li>;
        })}
      </ul>
    </LayoutGroup>
  </AutoHeight>;
}
