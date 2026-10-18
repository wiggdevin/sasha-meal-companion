"use client";

/**
 * The chat over the page (U22, 2026-10-04; owner: "if you're on a page and using the bottom nav bar,
 * by asking anything … maybe still an interactive chat that pops up on screen, and maybe the
 * background becomes shaded or dark. That way we don't have to go inside the chat field every time
 * and then try to get out of it and figure out where we were").
 *
 * An ivory E2 card rises from the dock over a charcoal scrim, showing the account's current chat
 * (components/coach/CoachConversation) with the assistant header and its scope chip. The dock stays the
 * composer. Nothing navigates: the page underneath keeps its scroll and state, made inert while the
 * card is up (inert-outside.ts), with its scroll held by `overflow: hidden` on <body> (never
 * `position: fixed`, which would jump it to the top). Escape, the scrim, the close button and the
 * back gesture (TabBar's history entry) all dismiss it.
 *
 * Motion (DESIGN.md §Motion, fluid rules): the card rises on the smooth spring from the dock's edge
 * and its content fades in once it has room; closing runs the other way, content first.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { Maximize2 } from "lucide-react";
import CoachConversation from "@/components/coach/CoachConversation";
import CoachHeader from "@/components/coach/CoachHeader";
import CloseButton from "@/components/ui/CloseButton";
import Button from "@/components/ui/Button";
import { inertOutside } from "@/components/dock/inert-outside";
import type { ChatScope } from "@/components/dock/chat-scope";
import { ASSISTANT_NAME } from "@/lib/brand";
import { INSTANT, MORPH, SPRINGS, fade } from "@/lib/design/motion";
import { lockBodyScroll } from "@/lib/dom/scroll-lock";
import { keyBelongsTo } from "@/lib/dom/sheet-a11y";
import styles from "./ChatOverlay.module.css";

export const CHAT_OVERLAY_LABEL = `Chat with ${ASSISTANT_NAME}`;

export default function ChatOverlay({ scope, dock, onClose, onOpenFull }: {
  scope: ChatScope;
  /** The dock: it stays live (it is the composer) while everything else is inert. */
  dock: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const reduce = useReducedMotion() === true;
  // The page is given back the moment the overlay starts to leave, not when its exit has played.
  const present = useIsPresent();
  const root = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const presentRef = useRef(present);
  useEffect(() => { presentRef.current = present; }, [present]);

  useLayoutEffect(() => {
    if (!present) return;
    const release = inertOutside([root.current, dock.current]);
    const unlock = lockBodyScroll(document.body);
    return () => { release(); unlock(); };
  }, [dock, present]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // The dock's field spends Escape on its own steps first (tray, text) and marks it handled; a
      // sheet opened inside the chat closes itself.
      if (event.key !== "Escape" || event.defaultPrevented || !presentRef.current) return;
      if (!keyBelongsTo(event.target, root.current)) return;
      if (root.current?.querySelector(".sheet-popover-root")) return;
      onCloseRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const frame = reduce ? INSTANT : SPRINGS.smooth;
  return <div ref={root} className={styles.root} role="dialog" aria-label={CHAT_OVERLAY_LABEL}
    data-chat-overlay={present ? "true" : "leaving"} inert={!present} aria-hidden={present ? undefined : true}>
    <motion.button type="button" tabIndex={-1} aria-label="Close chat" className={styles.scrim}
      onClick={onClose}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: reduce ? INSTANT : { ...fade("base", false), delay: 0.1 } }}
      transition={fade("base", reduce)} />
    {/* The card stops above the dock as tall as it is now (its text grows; --dock-height, TabBar). */}
    <motion.section className={styles.card}
      style={{ bottom: "calc(var(--safe-bottom) + var(--dock-height, 64px) + 24px + var(--dock-lift, 0px))" }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 32, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0, transition: INSTANT }
        : { opacity: 0, y: 32, scale: 0.96, transition: { ...SPRINGS.smooth, delay: 0.08 } }}
      transition={reduce ? INSTANT : { ...frame, opacity: fade("quick", false) }}>
      <motion.div className={styles.content}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1, transition: reduce ? INSTANT : MORPH.contentIn }}
        exit={{ opacity: 0, transition: reduce ? INSTANT : MORPH.contentOut }}>
        <CoachConversation scope={scope} variant="overlay" renderHeader={({ thinking }) =>
          <div className={styles.head}>
            <CoachHeader variant="overlay" scope={scope} thinking={thinking} trailing={<>
              {/* Under 360 px the words would crush the title, so the control becomes an icon. */}
              <Button variant="ghost" size="sm" onClick={onOpenFull} className="max-[359px]:hidden">
                Open full chat</Button>
              <Button variant="ghost" shape="circle" onClick={onOpenFull} aria-label="Open full chat"
                className="min-[360px]:hidden"><Maximize2 size={18} strokeWidth={1.75} aria-hidden="true" /></Button>
              <CloseButton label="Close chat" onClick={onClose} />
            </>} />
          </div>} />
      </motion.div>
    </motion.section>
  </div>;
}
