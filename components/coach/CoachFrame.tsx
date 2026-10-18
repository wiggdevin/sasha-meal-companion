"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { BUBBLE, DOCK_BOTTOM_OFFSET, TRAY_OPEN } from "@/components/dock/dock-motion";
import { useVisualViewport } from "@/lib/coach/use-visual-viewport";

/**
 * The chat's column: header, the transcript (the one scroller), and the slot under it.
 *
 * `fill="viewport"` (the /coach page) owns the full visual viewport. Route chrome must be passed
 * through `header`, never placed above it. The dock is the page's only composer, and its attach tray
 * can grow to TRAY_OPEN, so the bottom clearance is sized to that, not just the folded dock.
 * The frame is fixed to the screen: the body's own dock padding (globals.css) would otherwise make
 * the document taller than the screen, and a drag outside the transcript dragged the header away.
 * With the keyboard up the dock rides above it (TabBar's --dock-lift), so the frame keeps the dock's
 * live height (--dock-height, written by TabBar) clear instead of dropping its padding to 0.
 *
 * `fill="parent"` (the dock's chat overlay) fills the card it sits in; the card itself already
 * stops above the dock and the keyboard.
 */
/** Keyboard down: the folded dock may grow to its tray at any moment, so its full height is held. */
export const RESTING_CLEARANCE =
  `calc(var(--safe-bottom) + max(${TRAY_OPEN}px, var(--dock-height, 0px)) + ${DOCK_BOTTOM_OFFSET + 12}px)`;
/** Keyboard up: the dock as tall as it is now (field, grown text, tray) and its lift off the edge. */
export const KEYBOARD_CLEARANCE = `calc(var(--safe-bottom) + var(--dock-height, ${BUBBLE}px) + ${DOCK_BOTTOM_OFFSET + 8}px)`;

export default function CoachFrame({ header, transcript, composer, fill = "viewport" }: {
  header?: ReactNode; transcript: ReactNode; composer: ReactNode; fill?: "viewport" | "parent";
}) {
  const shell = useRef<HTMLDivElement>(null);
  const isKeyboardOpen = useVisualViewport(shell);
  const page = fill === "viewport";
  useEffect(() => {
    if (!page) return;
    document.body.dataset.coachKeyboard = isKeyboardOpen ? "open" : "closed";
    return () => { delete document.body.dataset.coachKeyboard; };
  }, [isKeyboardOpen, page]);
  const style: CSSProperties = page ? {
    position: "fixed", top: 0, left: 0, right: 0, maxWidth: 390, marginInline: "auto",
    height: "var(--visual-viewport-height, 100dvh)", overflow: "hidden", display: "flex", flexDirection: "column",
    paddingBottom: isKeyboardOpen ? KEYBOARD_CLEARANCE : RESTING_CLEARANCE,
    transform: "translateY(var(--visual-viewport-offset-top, 0px))",
  } : { height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" };
  return <div ref={shell} data-testid="coach-shell" data-fill={fill} style={style}>
    {header != null && header !== false && <header className="shrink-0">{header}</header>}
    {transcript}
    <div className="shrink-0">{composer}</div>
  </div>;
}
