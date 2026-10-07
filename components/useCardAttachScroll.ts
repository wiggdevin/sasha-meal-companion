"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { springScrollIntoView } from "@/lib/dom/spring-scroll";

const height = (el: Element | null | undefined) => (el instanceof HTMLElement ? el.offsetHeight : 0);

/**
 * How much shorter a meal card will be once the morph that opening a flow starts has settled, read in
 * the commit that starts it, before anything has moved: the hero takes its compact height, the macro
 * panel folds away (the split bar moves into the hero), and the tray rises from 16 px under the panel
 * to overlap the photo's foot. The tray's own content is swapped for the flow, whose height is not
 * known yet; it is taken as unchanged. Each moving box still has its old size while its content
 * already has the new.
 */
export function attachShrink(group: HTMLElement): number {
  let shrink = 0;
  const hero = group.querySelector("[data-meal-header]")?.parentElement;
  if (hero?.parentElement) shrink += height(hero.parentElement) - height(hero);
  const divider = group.querySelector<HTMLElement>("[data-after-dark-nutrition]");
  if (divider) shrink += [...divider.children].reduce((sum, child) => sum + height(child), 0);
  const tray = group.querySelector<HTMLElement>("[data-card-tray]");
  if (tray) {
    const style = getComputedStyle(tray);
    const overlap = parseFloat(style.getPropertyValue("--tray-overlap")) || 0;
    shrink += (parseFloat(style.marginTop) || 0) + overlap;
  }
  return shrink;
}

/**
 * When a flow opens inside a meal card, brings the card's top to the top of the screen on the same
 * spring the card morphs on, so the meal and its flow arrive together as one view. The
 * target is capped at the furthest the page will scroll once the card has folded; aiming past it, the
 * page climbed while the card was tall and was pulled back as it folded (owner, 2026-10-04).
 */
export function useCardAttachScroll(group: RefObject<HTMLElement | null>, attached: boolean, reduce: boolean) {
  const was = useRef(attached);
  useLayoutEffect(() => {
    const opened = attached && !was.current;
    was.current = attached;
    const el = group.current;
    if (!opened || !el) return;
    return springScrollIntoView(el, reduce, attachShrink(el));
    // Reduced motion is read when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attached, group]);
}
