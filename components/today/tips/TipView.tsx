"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import type { BoardTip } from "@/lib/today/board";
import TipDemo from "@/components/today/tips/TipDemo";
import TipGlyph, { glyphOf } from "@/components/today/tips/TipGlyph";
import { NextGlyph, TipFace } from "@/components/today/TipTile";
import Button from "@/components/ui/Button";
import { TIP_CORNER, TIP_LAYOUT_ID } from "@/components/today/tips/shared";
import { boardMorph, type Box } from "@/components/today/useDayCardMotion";
import tileStyles from "@/components/today/TipTile.module.css";
import styles from "@/components/today/tips/TipView.module.css";

/** The tile the view grew from: its tips, the one on show and its size, so the view can carry the
 *  tile's face at the tile's own size while it grows and while it lands. */
export type TipFaceBox = { tips: BoardTip[]; index: number; width: number; height: number };

/** Paging through the tips from inside the view (OD17): where this tip sits, and the step. */
export type TipPaging = { index: number; count: number; onPage: (step: 1 | -1) => void };

/** A view on its way back: the tile's box in the stage, and the size the view had when it began. */
export type TipClosing = { to: Box; from: { width: number; height: number } };

/**
 * A tip's full view (2026-10-03), grown out of its tile in place: a container transform on the
 * board's morph timeline (components/today/useDayCardMotion.ts `BOARD_MORPH`), shared with the
 * explainer player. The box grows from the tile's box (one shared layout id) in the tile's own
 * material and is opaque from the first frame (`layoutCrossfade`: Motion's crossfade started the
 * view at opacity 0 over a stretched copy of the tile, the flash the owner saw). The tile's face
 * rides inside at its own size and fades as the box starts to grow; the view's content holds its
 * size and place (`layout="position"`) and fades up a beat later, so the box's edge reveals it.
 *
 * Closing (`closing`) runs the same spring backwards: the box shrinks into the tile's box, still
 * opaque, its content fading first and the tile's face fading back in as it lands; then the stage
 * hands over to the tile (`onClosed`). Under reduced motion nothing travels.
 *
 * Inside: the glyph, the headline and the X; the one-line summary; the demonstration, which takes
 * whatever room the board leaves; then the steps; then, with more than one tip, Previous, "n of N"
 * and Next (OD17, 2026-10-12: paging lives here, not on the tile). Paging swaps the tip in the same
 * view and says the new one in a live region. Focus goes to the X when the view opens, and Escape
 * closes it.
 */
export default function TipView({ tip, minHeight, face, closing = null, paging = null, onClose, onClosed, ref }: {
  tip: BoardTip;
  paging?: TipPaging | null;
  /** The board's height when the tip opened, less the stage's padding: the view fills it. */
  minHeight?: number;
  face?: TipFaceBox | null;
  closing?: TipClosing | null;
  onClose: () => void;
  /** The shrink has landed in the tile. */
  onClosed?: () => void;
  ref?: Ref<HTMLElement>;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const t = boardMorph(reduce);
  // Shrinking back into its tile, the view is already gone for assistive tech and the keyboard.
  const present = useIsPresent();
  const away = !present || closing !== null;
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
  // Said only after a page turn: opening the view moves focus to its X, which names it already.
  const [said, setSaid] = useState<string | null>(null);
  const [lastId, setLastId] = useState(tip.id);
  if (tip.id !== lastId) {
    setLastId(tip.id);
    setSaid(`Tip ${(paging?.index ?? 0) + 1} of ${paging?.count ?? 1}. ${tip.title ? `${tip.title}. ` : ""}${tip.text}`);
  }
  const steps = tip.steps && tip.steps.length > 0 ? tip.steps : null;
  const box = closing
    ? { position: "absolute" as const, top: closing.to.top, left: closing.to.left, width: closing.to.width, height: closing.to.height }
    : { minHeight: minHeight && minHeight > 0 ? minHeight : undefined };

  return <motion.section ref={ref} aria-labelledby={headingId} data-tip-view={tip.id}
    data-closing={closing ? "" : undefined}
    className={`matte-grain ${tileStyles.surface} ${styles.view}`}
    style={{ ...TIP_CORNER, ...box }}
    inert={away} aria-hidden={away ? true : undefined}
    layoutId={reduce ? undefined : TIP_LAYOUT_ID} layoutCrossfade={false} transition={t.frame}
    onLayoutAnimationComplete={closing ? onClosed : undefined}
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <motion.div className={styles.inner} layout={reduce ? false : "position"}
      style={closing ? { position: "absolute", top: 0, left: 0, width: closing.from.width, height: closing.from.height } : undefined}
      initial={reduce ? false : { opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }}
      transition={{ opacity: closing ? t.contentOut : t.contentIn, layout: t.frame }}>
      <header className={styles.header}>
        <span className={tileStyles.glyph}><TipGlyph glyph={glyphOf(tip)} /></span>
        <div className={styles.heading}>
          <span className={tileStyles.eyebrow}>{tip.source === "coach" ? "From your coach" : "Tip"}</span>
          <h3 id={headingId} className={styles.title}>{tip.title ?? tip.text}</h3>
        </div>
        <button ref={closeRef} type="button" className={`tap ${styles.close}`} onClick={onClose} aria-label="Close tip">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>
      {tip.title && <p className={styles.summary}>{tip.text}</p>}
      <div className={styles.stage}>
        {tip.demo ? <TipDemo key={tip.id} kind={tip.demo} />
          : <span className={styles.glyphLarge} aria-hidden="true"><TipGlyph glyph={glyphOf(tip)} size={40} /></span>}
      </div>
      {steps && <ol className={styles.steps}>
        {steps.map((step, i) => <li key={step} className={styles.step}>
          <span className={styles.stepNumber} aria-hidden="true">{i + 1}</span>
          <span>{step}</span>
        </li>)}
      </ol>}
      {paging && paging.count > 1 && <nav className={styles.paging} aria-label="Tips">
        <Button variant="secondary" shape="circle" size="sm" aria-label="Previous tip"
          onClick={() => paging.onPage(-1)}><NextGlyph back /></Button>
        <span className={styles.position} aria-hidden="true">{paging.index + 1} of {paging.count}</span>
        <Button variant="secondary" shape="circle" size="sm" aria-label="Next tip"
          onClick={() => paging.onPage(1)}><NextGlyph /></Button>
      </nav>}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{said}</p>
    </motion.div>
    {face && !reduce && <motion.div className={`${tileStyles.tip} ${styles.face}`} data-tip-face="" aria-hidden="true"
      layout="position" style={{ width: face.width, height: face.height }}
      initial={{ opacity: 1 }} animate={{ opacity: closing ? 1 : 0 }}
      transition={{ opacity: closing ? t.faceIn : t.faceOut, layout: t.frame }}>
      <TipFace tips={face.tips} index={face.index} />
    </motion.div>}
  </motion.section>;
}
