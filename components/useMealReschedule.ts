"use client";

import { useEffect, useRef, useState } from "react";
import { selectionHaptic } from "@/lib/haptics";
import { leftSwipeOutcome, swipeStage, swipeTravel } from "@/lib/today/swipe-detents";

export const TIMELINE_STEP = 44;
export function quarterTime(index: number): string {
  const total = Math.max(0, Math.min(95, Math.round(index))) * 15;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
export function draggedMealTime(time: string, deltaY: number): string {
  const [hours, minutes] = time.split(":").map(Number);
  return quarterTime((hours * 60 + minutes) / 15 + deltaY / TIMELINE_STEP);
}
export type TimelinePosition = { y: number; offset: number };

export { leftSwipeOutcome } from "@/lib/today/swipe-detents";

/** Native touch listeners retain normal page scrolling until an intentional hold. */
export function useMealReschedule(time: string, onSave?: (time: string) => void | Promise<void>, onSwap?: () => void, onDelete?: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saveRef = useRef(onSave);
  const swapRef = useRef(onSwap);
  const deleteRef = useRef(onDelete);
  useEffect(() => { saveRef.current = onSave; swapRef.current = onSwap;
    deleteRef.current = onDelete; }, [onSave, onSwap, onDelete]);
  const [preview, setPreview] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelinePosition | null>(null);
  const [swipeX, setSwipeX] = useState(0);
  /** True while a finger drives the swipe; off, the card and tray settle on a short spring. */
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let active = true;
    let gesture: { x: number; y: number; currentY: number; held: boolean; next: string;
      touch: boolean; swipe: boolean; dx: number; base: number; width: number; stage: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scrollTimer: ReturnType<typeof setInterval> | undefined;
    let oldUserSelect = "";
    const bounds = () => ({ top: 110, bottom: Math.max(154, window.innerHeight - 110) });
    const update = () => {
      if (!gesture?.held) return;
      const { top, bottom } = bounds();
      const y = Math.max(top, Math.min(bottom, gesture.currentY));
      const index = Math.max(0, Math.min(95, gesture.base + (y - gesture.y) / TIMELINE_STEP));
      const next = quarterTime(index);
      if (next !== gesture.next) selectionHaptic();
      gesture.next = next;
      setPreview(next);
      setTimeline({ y, offset: y - index * TIMELINE_STEP });
    };
    const clear = () => {
      clearTimeout(timer);
      clearInterval(scrollTimer);
      if (gesture?.held) document.body.style.userSelect = oldUserSelect;
      gesture = null;
      if (active) { setPreview(null); setTimeline(null); setSwipeX(0); setDragging(false); }
    };
    const start = (x: number, y: number, target: EventTarget | null, touch: boolean) => {
      if ((!saveRef.current && !swapRef.current && !deleteRef.current) || busy.current) return;
      const control = target instanceof Element ? target.closest("button, input, textarea, a") : null;
      if (control && !control.hasAttribute("data-card-edit")) return;
      clear();
      suppressClick.current = false;
      const [h, m] = time.split(":").map(Number);
      gesture = { x, y, currentY: y, held: false, next: time, touch, swipe: false,
        dx: 0, stage: 0, base: Math.round((h * 60 + m) / 15),
        width: element.getBoundingClientRect().width || element.clientWidth || 300 };
      if (!saveRef.current) return;
      timer = setTimeout(() => {
        if (!gesture) return;
        gesture.held = true;
        const { top, bottom } = bounds();
        gesture.y = Math.max(top, Math.min(bottom, gesture.y));
        oldUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        window.getSelection()?.removeAllRanges();
        suppressClick.current = true;
        setError(null);
        selectionHaptic();
        update();
        // Holding near an edge scrolls the entire day, independent of card height/count.
        scrollTimer = setInterval(() => {
          if (!gesture?.held) return;
          const { top, bottom } = bounds();
          const y = gesture.currentY;
          const speed = y < top + 50 ? -Math.min(1, (top + 50 - y) / 50)
            : y > bottom - 50 ? Math.min(1, (y - bottom + 50) / 50) : 0;
          if (!speed) return;
          const delta = (Math.max(top, Math.min(bottom, y)) - gesture.y) / TIMELINE_STEP;
          gesture.base = Math.max(-delta, Math.min(95 - delta, gesture.base + speed * .18));
          update();
        }, 16);
      }, 450);
    };
    const move = (x: number, y: number, event: Event) => {
      if (!gesture) return;
      const dx = x - gesture.x;
      const dy = y - gesture.y;
      if (!gesture.held) {
        if (!gesture.swipe && Math.hypot(dx, dy) > 8) {
          clearTimeout(timer);
          suppressClick.current = true;
          if (((swapRef.current && dx > 8) || (deleteRef.current && dx < -8))
            && Math.abs(dx) > Math.abs(dy) * 1.4) { gesture.swipe = true; setDragging(true); }
          else { clear(); return; }
        }
        if (gesture.swipe) {
          if (event.cancelable) event.preventDefault();
          gesture.dx = dx;
          if (dx > 0) { setSwipeX(Math.min(96, dx)); return; }
          // Left: the card catches where Clear, then Delete, are fully shown (a tick each), and a
          // tick says a release will now delete.
          const stage = swipeStage(-dx, gesture.width);
          if (stage > gesture.stage) selectionHaptic();
          gesture.stage = stage;
          setSwipeX(-swipeTravel(-dx, gesture.width));
        }
        return;
      }
      if (event.cancelable) event.preventDefault();
      gesture.currentY = y;
      update();
    };
    const end = () => {
      const completed = gesture;
      clear();
      if (completed?.swipe && completed.dx >= 64) { selectionHaptic(); swapRef.current?.(); return; }
      if (completed?.swipe && completed.dx < 0) {
        const outcome = leftSwipeOutcome(-completed.dx, completed.width);
        if (outcome === "delete") { selectionHaptic(); deleteRef.current?.(); }
        else if (outcome === "actions") setSwipeX(-160);
        else if (outcome === "clear") setSwipeX(-80);
        return;
      }
      if (!completed?.held || completed.next === time) return;
      busy.current = true;
      setSaving(true);
      Promise.resolve().then(() => { if (active) return saveRef.current?.(completed.next); }).catch(() => {
        if (mounted.current) setError("Time could not be saved. Try again.");
      }).finally(() => { busy.current = false; if (mounted.current) setSaving(false); });
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { clear(); return; }
      start(event.touches[0].clientX, event.touches[0].clientY, event.target, true);
    };
    const touchMove = (event: TouchEvent) => {
      if (!gesture?.touch) return;
      if (event.touches.length !== 1) { clear(); return; }
      move(event.touches[0].clientX, event.touches[0].clientY, event);
    };
    const touchEnd = () => { if (gesture?.touch) end(); };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      start(event.clientX, event.clientY, event.target, false);
      if (gesture) event.preventDefault();
    };
    const pointerMove = (event: PointerEvent) => { if (gesture && !gesture.touch) move(event.clientX, event.clientY, event); };
    const pointerUp = () => { if (gesture && !gesture.touch) end(); };
    const contextMenu = (event: Event) => { event.preventDefault(); };
    const selectStart = (event: Event) => { if (gesture) event.preventDefault(); };
    const cancelKey = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    element.addEventListener("touchstart", touchStart, { passive: true });
    document.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("touchend", touchEnd);
    document.addEventListener("touchcancel", clear);
    element.addEventListener("pointerdown", pointerDown);
    document.addEventListener("pointermove", pointerMove);
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", clear);
    element.addEventListener("contextmenu", contextMenu);
    document.addEventListener("selectstart", selectStart);
    document.addEventListener("keydown", cancelKey);
    window.addEventListener("blur", clear);
    return () => {
      active = false;
      clear();
      element.removeEventListener("touchstart", touchStart);
      document.removeEventListener("touchmove", touchMove);
      document.removeEventListener("touchend", touchEnd);
      document.removeEventListener("touchcancel", clear);
      element.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("pointerup", pointerUp);
      document.removeEventListener("pointercancel", clear);
      element.removeEventListener("contextmenu", contextMenu);
      document.removeEventListener("selectstart", selectStart);
      document.removeEventListener("keydown", cancelKey);
      window.removeEventListener("blur", clear);
    };
  }, [time]);

  function consumeSuppressedClick() {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }
  function toggleActions() { setSwipeX((current) => current < 0 ? 0 : -160); }
  function closeActions() { setSwipeX(0); }
  return { ref, preview, timeline, swipeX, dragging, error, saving, consumeSuppressedClick,
    toggleActions, closeActions };
}
