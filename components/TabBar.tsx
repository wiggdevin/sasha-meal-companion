"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, useReducedMotion } from "motion/react";
import type { BodyCapability } from "@/lib/health/capability";
import AssistantField from "@/components/dock/AssistantField";
import ChatOverlay from "@/components/dock/ChatOverlay";
import { onOverlayEntry, useChatHistory } from "@/components/dock/chat-history";
import { localIsoDate, scopeForLocation, type ChatScope } from "@/components/dock/chat-scope";
import TabCapsule, { TABS, rememberTab } from "@/components/dock/TabCapsule";
import { BUBBLE, COACH_HREF, DOCK_BOTTOM_OFFSET, SPLIT } from "@/components/dock/dock-motion";
import { LiquidLensFilters, useLensing } from "@/components/dock/liquid-lens";
import { useUnreadTracking } from "@/components/coach/unread-threads";
import styles from "./TabBar.module.css";

export { tabSlots } from "@/components/dock/TabCapsule";

/** Every tab keeps its label at every width; below this the slot padding tightens instead. */
export const COMPACT_BELOW_PX = 360;
export function tabBarLayout(width: number, tabCount: number) {
  return { compact: width < COMPACT_BELOW_PX, columns: tabCount };
}

/** Keep the dock above the on-screen keyboard while the assistant field is being typed in. The
 *  lift is also written on <html>, so the chat overlay's card stops above the risen dock. */
function useKeyboardLift(dock: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const element = dock.current;
    if (!viewport || !element) return;
    const targets = [element, document.documentElement];
    const write = (value: string) => targets.forEach((target) => target.style.setProperty("--dock-lift", value));
    if (!active) { write("0px"); return; }
    const apply = () => {
      const covered = window.innerHeight - (viewport.height + viewport.offsetTop);
      write(`${Math.max(0, Math.round(covered))}px`);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      write("0px");
    };
  }, [dock, active]);
}

/** The dock's live height (the field grows with its text and its tray) on <html> as --dock-height,
 *  so the /coach frame and the chat overlay keep their bottom content clear of it. */
function useDockHeight(dock: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const write = () => root.style.setProperty("--dock-height", `${Math.round(element.getBoundingClientRect().height)}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => { observer.disconnect(); root.style.removeProperty("--dock-height"); };
  }, [dock]);
}

/** A field the keyboard types into (not a checkbox, button or file picker). */
export function isTypingField(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable || node instanceof HTMLTextAreaElement) return true;
  if (node instanceof HTMLInputElement) {
    return !["checkbox", "radio", "range", "file", "color", "button", "submit", "reset", "hidden"]
      .includes(node.type);
  }
  return false;
}

/**
 * While the user types in a field outside the dock, the dock steps aside (body[data-typing]), as a
 * phone's tab bar does when the keyboard is up: it would otherwise cover a field near the bottom of
 * the screen, such as a meal card's "Ask for a different idea" (2026-10-01).
 */
function useStepAsideWhileTyping(dock: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const sync = () => {
      const active = document.activeElement;
      const outside = isTypingField(active) && !dock.current?.contains(active);
      if (outside) document.body.dataset.typing = "field";
      else delete document.body.dataset.typing;
    };
    // focusout fires before the next element takes focus; read the result a frame later.
    const later = () => requestAnimationFrame(sync);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", later);
      delete document.body.dataset.typing;
    };
  }, [dock]);
}

/**
 * The floating dock: a liquid-glass capsule of four destinations and the assistant bubble beside it.
 * Tapping the bubble stretches it into the ask field while the capsule folds to one icon; that
 * icon brings the capsule back. On /coach the field is the page's composer, so it starts open.
 * On every other dock page, asking opens the chat overlay above the page (U22) and the field
 * stays its composer until the overlay closes.
 */
export default function TabBar(_props: { bodyCapability?: BodyCapability } = {}) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const reduce = useReducedMotion() ?? false;
  const onCoach = pathname === COACH_HREF || pathname.startsWith(`${COACH_HREF}/`);
  // /week is a page of Today, so it lights Today.
  const activeIndex = TABS.findIndex((tab) =>
    tab.href === "/" ? pathname === "/" || pathname === "/week" || pathname.startsWith("/week/")
      : pathname.startsWith(tab.href));
  useEffect(() => { rememberTab(activeIndex); }, [activeIndex]);
  // The dock owns the unread badge, so it asks for it: on open and on each return to the app.
  useUnreadTracking();

  // Open state belongs to the route it was set on; a new route starts from its own default.
  const [search, setSearch] = useState({ path: pathname, open: onCoach });
  const open = search.path === pathname ? search.open : onCoach;
  const setOpen = useCallback((next: boolean) => setSearch({ path: pathname, open: next }), [pathname]);

  // The chat overlay belongs to the page it was opened on: a route change closes it.
  const [chat, setChat] = useState<{ path: string; scope: ChatScope } | null>(null);
  const chatOpen = !onCoach && chat !== null && chat.path === pathname;

  const dock = useRef<HTMLElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => setRowWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const lensing = useLensing();
  const [typing, setTyping] = useState(false);
  useKeyboardLift(dock, (open || chatOpen) && typing);
  useStepAsideWhileTyping(dock);
  useDockHeight(dock);

  const capsuleWidth = rowWidth > 0 ? rowWidth - SPLIT - BUBBLE : 0;
  const compact = rowWidth > 0 && tabBarLayout(rowWidth + 32, TABS.length).compact;

  const closeChatNow = useCallback(() => { setChat(null); setOpen(false); }, [setOpen]);
  const dismissChat = useChatHistory(chatOpen, closeChatNow);
  const openChat = useCallback(() => {
    if (onCoach) return;
    setChat({ path: pathname, scope: scopeForLocation(pathname, window.location.search, localIsoDate()) });
  }, [onCoach, pathname]);
  function openFullChat() {
    // Replace the overlay's own history entry, so Back from /coach returns to the page, not to it.
    if (onOverlayEntry()) router.replace(COACH_HREF);
    else router.push(COACH_HREF);
  }
  const fieldOpen = open || chatOpen;

  function openField() {
    // Commit synchronously so the field is focusable inside this tap: iOS only raises the
    // keyboard for a focus() that happens during the user's gesture.
    flushSync(() => setOpen(true));
    dock.current?.querySelector<HTMLTextAreaElement>('textarea[role="searchbox"]')?.focus({ preventScroll: true });
  }

  function closeField() {
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (chatOpen) dismissChat();
    setOpen(false);
  }

  return <>
    <AnimatePresence>
      {chatOpen && chat && <ChatOverlay key="chat" scope={chat.scope} dock={dock}
        onClose={dismissChat} onOpenFull={openFullChat} />}
    </AnimatePresence>
    <nav ref={dock} className={`morphing-dock matte ${styles.dock} fixed inset-x-4 z-40`} aria-label="Primary"
      data-lens={lensing ? "on" : undefined}
      onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
      style={{ bottom: `calc(var(--safe-bottom) + ${DOCK_BOTTOM_OFFSET}px)` }}>
      {lensing && <LiquidLensFilters pillWidth={capsuleWidth} height={BUBBLE} />}
      {/* Bottom-aligned so the ask field can grow upward into its attach tray. */}
      <div ref={row} className="flex min-h-16 items-end justify-between" style={{ gap: SPLIT }}>
        <TabCapsule activeIndex={activeIndex} folded={fieldOpen} width={capsuleWidth} compact={compact}
          reduce={reduce} onUnfold={closeField} />
        <AssistantField open={fieldOpen} width={capsuleWidth} onCoach={onCoach} reduce={reduce}
          onOpen={openField} onClose={() => setOpen(false)} dock={dock}
          chatOpen={chatOpen} onOpenChat={openChat} onCloseChat={dismissChat} />
      </div>
    </nav>
  </>;
}
