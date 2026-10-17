"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotionConfig } from "motion/react";
import type { BoardTip } from "@/lib/today/board";
import TipView, { type TipClosing, type TipFaceBox } from "@/components/today/tips/TipView";
import { TIP_OPEN_ATTR } from "@/components/today/tips/shared";
import {
  MORPH_SETTLE_MS, TILES_COVERED, TILES_SHOWN, boardMorph, boxWithin, unhide,
} from "@/components/today/useDayCardMotion";
import styles from "@/components/today/tips/TipStage.module.css";

/** The board's padding around the open view (DayBoard.module.css `.board`: 4 px above, 16 px below). */
const STAGE_PAD_Y = 20;

/** Focus that was in the view, or went nowhere when the view turned inert, goes back to the tile. */
function focusWasInView(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.closest("[data-tip-view]") !== null;
}

/**
 * The board with a tip open in place (2026-10-03), the explainer stage's pattern
 * (components/today/ExplainerPlayer.tsx `ExplainerStage`): no pop-up, no portal. The view lies over
 * the tiles; they stay mounted under it, out of the flow in exactly the box they had, inert and
 * hidden from assistive tech, and they fade and blur away underneath while the view grows over
 * them, never cut on the first frame (owner, 2026-10-03: "Keep those cards there"). Closing is the
 * same timeline backwards (useDayCardMotion.ts `BOARD_MORPH`): the view shrinks into its tile while
 * the tiles fade back in, and only once it has landed does the stage hand over to the tile.
 *
 * The view fills the room the board had, so the card keeps its height; when the view needs more,
 * the board's height (DayBoard's one AutoHeight) springs on the frame's own gentle spring. Focus moves to the view's X and back
 * to the tile without scrolling the page. A board that leaves the screen closes its tip at once.
 *
 * Paging is the view's (OD17): Previous and Next swap the tip inside the one open view, and the
 * stage holds which tip the tile shows (`shownId`), so the view closes into the tip it was last on.
 */
export default function TipStage({ tips, active, children }: {
  tips: BoardTip[];
  /** False while another face of the Day card is on show. */
  active: boolean;
  /** `open(tip, from)`: `from` is the control that opened it, inside the board's tiles; `shownId`
   *  is the tip the tile shows. */
  children: (open: (tip: BoardTip, from: HTMLElement) => void, shownId: string | null) => ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const t = boardMorph(reduce);
  const [openId, setOpenId] = useState<string | null>(null);
  // One key per opening: a page turn keeps the view, a new opening always mounts a fresh one.
  const [opening, setOpening] = useState(0);
  // Held by id, from the first tip the board had: a reorder never switches the tile's tip.
  const [shownId, setShownId] = useState<string | null>(() => tips[0]?.id ?? null);
  const [room, setRoom] = useState(0);
  const [face, setFace] = useState<TipFaceBox | null>(null);
  const [closing, setClosing] = useState<TipClosing | null>(null);
  if (!active && openId !== null) { setOpenId(null); setClosing(null); }
  const shown = tips.find((tip) => tip.id === openId) ?? null;
  // The tiles are covered while the view is open; closing, they are back in the flow and fading in.
  const covered = shown !== null && closing === null;
  const stage = useRef<HTMLDivElement | null>(null);
  // The tip the last page turn went to, until the render that shows it.
  const pagedTo = useRef<string | null>(null);
  useEffect(() => { pagedTo.current = null; }, [openId]);
  // Closing hands focus back to the tile the tip grew from; a board that left the screen does not.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (openId !== null) return;
    // The view hid its tile while it stood in for it (`layoutCrossfade={false}`); Motion shows it
    // again as it projects it back, and this makes sure it is shown once the view has handed over.
    const tile = stage.current?.querySelector<HTMLElement>("[data-tip-tile]");
    if (tile) unhide(tile);
    if (!returnFocus.current) return;
    returnFocus.current = false;
    if (!focusWasInView()) return;
    stage.current?.querySelector<HTMLElement>(`[${TIP_OPEN_ATTR}]`)?.focus({ preventScroll: true });
  }, [openId]);

  const finish = useCallback(() => { setClosing(null); setOpenId(null); }, []);
  // The shrink reports its landing; if it never does (nothing to travel), the tile takes over anyway.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finish, MORPH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [closing, finish]);

  // The view fills the room the tiles took, read from the tiles' own layer as the tip opens, and
  // carries the tile's face at the tile's size.
  const open = (tip: BoardTip, from: HTMLElement) => {
    const tiles = from.closest<HTMLElement>("[data-tip-tiles]");
    setRoom(Math.max(0, (tiles?.offsetHeight ?? 0) - STAGE_PAD_Y));
    setFace({ tips, index: Math.max(0, tips.indexOf(tip)), width: from.offsetWidth, height: from.offsetHeight });
    setClosing(null);
    setOpenId(tip.id);
    setShownId(tip.id);
    setOpening((n) => n + 1);
  };
  // A page turn swaps the tip in the open view; the tile and the face it lands on follow.
  const page = (step: 1 | -1) => {
    if (!shown || closing || tips.length < 2) return;
    // From the latest page turn, not this render's tip, so two taps in one batch move two tips.
    const at = tips.findIndex((tip) => tip.id === (pagedTo.current ?? shown.id));
    const index = ((at < 0 ? 0 : at) + step + tips.length) % tips.length;
    pagedTo.current = tips[index].id;
    setOpenId(tips[index].id);
    setShownId(tips[index].id);
    setFace((box) => box && { ...box, tips, index });
  };

  const close = () => {
    if (closing) return;
    returnFocus.current = true;
    const root = stage.current;
    const tile = root?.querySelector<HTMLElement>("[data-tip-tile]");
    const view = root?.querySelector<HTMLElement>("[data-tip-view]");
    if (reduce || !root || !tile || !view) { finish(); return; }
    setClosing({ to: boxWithin(tile, root), from: { width: view.offsetWidth, height: view.offsetHeight } });
  };

  return <LayoutGroup>
    <div ref={stage} className={styles.stage} data-tip-shown={covered ? "" : undefined}>
      <motion.div className={styles.under} data-tip-tiles="" data-covered={covered ? "" : undefined}
        inert={covered} aria-hidden={covered ? true : undefined}
        initial={false} animate={covered ? TILES_COVERED : TILES_SHOWN}
        transition={covered ? t.tilesOut : t.tilesIn}>
        {children(open, shownId)}
      </motion.div>
      <AnimatePresence initial={false}>
        {/* One key per opening: a page turn swaps its tip in place, never re-grows it. */}
        {shown && <TipView key={`tip-view-${opening}`} tip={shown} minHeight={room} face={face} closing={closing}
          paging={{ index: Math.max(0, tips.indexOf(shown)), count: tips.length, onPage: page }}
          onClose={close} onClosed={finish} />}
      </AnimatePresence>
    </div>
  </LayoutGroup>;
}
