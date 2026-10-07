"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { captureTrigger, installTriggerTracking } from "@/lib/dom/popover-anchor";
import { placePopover, type PopoverPlacement, type PopoverRect, type PopoverSide } from "@/lib/dom/popover-place";

function rectOf(element: Element | null): PopoverRect | null {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const { top, bottom, left, right } = element.getBoundingClientRect();
  return { top, bottom, left, right };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Places an anchored pop-up card (lib/dom/popover-place.ts) and keeps it placed while it grows,
 * the window resizes or the keyboard opens. `root` is the full-screen dialog layer: its computed
 * padding carries the safe areas and the dock clearance (globals.css .sheet-popover-root), so the
 * insets come from the same CSS variables as the rest of the app. `body`, when given, is the
 * card's scrolling region, so the card's natural height counts its whole content.
 *
 * The trigger and its rect are read on the first render, before the card's own autoFocus or
 * focus move can change what is focused. Placement runs in a layout effect, before first paint.
 */
export function usePopoverPlacement(
  root: RefObject<HTMLElement | null>,
  card: RefObject<HTMLElement | null>,
  body?: RefObject<HTMLElement | null>,
): { placement: PopoverPlacement | null; trigger: Element | null } {
  const [trigger] = useState(() => {
    installTriggerTracking();
    return captureTrigger();
  });
  const [triggerRect] = useState(() => rectOf(trigger));
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const side = useRef<PopoverSide | undefined>(undefined);

  useLayoutEffect(() => {
    const layer = root.current;
    const surface = card.current;
    if (!layer || !surface) return;
    const place = (remeasureTrigger: boolean) => {
      const style = getComputedStyle(layer);
      const viewport = window.visualViewport;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewHeight = viewport?.height ?? window.innerHeight;
      const scroller = body?.current;
      const natural = surface.offsetHeight + (scroller ? scroller.scrollHeight - scroller.clientHeight : 0);
      const anchor = remeasureTrigger && trigger?.isConnected ? rectOf(trigger) : triggerRect;
      const next = placePopover({
        trigger: anchor,
        viewportWidth: viewport?.width ?? window.innerWidth,
        areaTop: viewTop + px(style.paddingTop),
        areaBottom: viewTop + viewHeight - px(style.paddingBottom),
        cardHeight: natural,
        side: side.current,
        layerHeight: layer.clientHeight || window.innerHeight,
      });
      side.current = next.side;
      setPlacement((previous) => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    place(false);
    const onViewport = () => place(true);
    window.addEventListener("resize", onViewport);
    window.visualViewport?.addEventListener("resize", onViewport);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place(false));
    if (observer) {
      observer.observe(surface);
      const scroller = body?.current;
      if (scroller) for (const child of Array.from(scroller.children)) observer.observe(child);
    }
    return () => {
      window.removeEventListener("resize", onViewport);
      window.visualViewport?.removeEventListener("resize", onViewport);
      observer?.disconnect();
    };
  }, [root, card, body, trigger, triggerRect]);

  return { placement, trigger };
}
