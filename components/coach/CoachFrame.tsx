"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { DOCK_BOTTOM_OFFSET, TRAY_OPEN } from "@/components/dock/dock-motion";
import { useVisualViewport } from "@/lib/coach/use-visual-viewport";

/**
 * The chat's column: header, the transcript (the one scroller), and the slot under it.
 *
 * `fill="viewport"` (the /coach page) owns the full visual viewport. Route chrome must be passed
 * through `header`, never placed above it. The dock is the page's only composer, and its attach tray
 * can grow to TRAY_OPEN, so the bottom clearance is sized to that, not just the folded dock.
 *
 * `fill="parent"` (the dock's chat overlay) fills the card it sits in; the card itself already
 * stops above the dock and the keyboard.
 */
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
  const dockClearance = TRAY_OPEN + DOCK_BOTTOM_OFFSET + 12;
  const style: CSSProperties = page ? {
    height: "var(--visual-viewport-height, 100dvh)", overflow: "hidden", display: "flex", flexDirection: "column",
    paddingBottom: isKeyboardOpen ? 0 : `calc(var(--safe-bottom) + ${dockClearance}px)`,
    transform: "translateY(var(--visual-viewport-offset-top, 0px))",
  } : { height: "100%", overflow: "hidden", display: "flex", flexDirection: "column" };
  return <div ref={shell} data-testid="coach-shell" data-fill={fill} style={style}>
    {header != null && header !== false && <header className="shrink-0">{header}</header>}
    {transcript}
    <div className="shrink-0">{composer}</div>
  </div>;
}
