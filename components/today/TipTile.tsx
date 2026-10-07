"use client";

import { useId, useState } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import type { BoardTip } from "@/lib/today/board";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import TipGlyph, { glyphOf } from "@/components/today/tips/TipGlyph";
import { BOARD_MORPH } from "@/components/today/useDayCardMotion";
import { TIP_CORNER, TIP_LAYOUT_ID, TIP_OPEN_ATTR } from "@/components/today/tips/shared";
import styles from "@/components/today/TipTile.module.css";
import Button from "@/components/ui/Button";

/** Past this many tips the dots stop reading as a count, so a figure stands in for them. */
export const MAX_DOTS = 7;

/** What a screen reader hears when the tip changes, and reads in place of the drawn stack. */
function spoken(tip: BoardTip, index: number, count: number): string {
  const lead = tip.source === "coach" ? "From your coach" : "Tip";
  return `${lead} ${index + 1} of ${count}. ${tip.title ? `${tip.title}. ` : ""}${tip.text}`;
}

const QUOTE_PATH = "M0 32V19.2C0 8.6 6 2.2 16.4 0l1.8 4.2C12 6.1 9.2 9.9 9 15.2h8V32H0Zm22 0V19.2C22 8.6 28 2.2 38.4 0l1.6 4.2C34 6.1 31.2 9.9 31 15.2h8V32H22Z";

function Quote() {
  return <svg className={styles.quote} width="28" height="22" viewBox="0 0 40 32" aria-hidden="true">
    <path fill="currentColor" d={QUOTE_PATH} />
  </svg>;
}

function Slide({ tip }: { tip: BoardTip }) {
  return <>
    <span className={styles.head}>
      <span className={styles.glyph}><TipGlyph glyph={glyphOf(tip)} /></span>
      <span className={styles.eyebrow}>{tip.source === "coach" ? "Coach" : "Tip"}</span>
    </span>
    {tip.title && <span className={styles.title}>{tip.title}</span>}
    <span className={styles.body}>{tip.text}</span>
  </>;
}

function Dots({ tips, index }: { tips: BoardTip[]; index: number }) {
  const count = tips.length;
  if (count <= 1) return null;
  return count <= MAX_DOTS
    ? <span className={styles.dots} aria-hidden="true">
      {tips.map((item, i) => <span key={item.id} className={styles.dot} data-current={i === index || undefined} />)}
    </span>
    : <span className={styles.count} aria-hidden="true">{index + 1}/{count}</span>;
}

function NextGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.5 6 6 6-6 6" /></svg>;
}

/**
 * The tile's face as drawn at rest, without its controls: what the full view carries at the tile's
 * own size while it grows out of the tile and fades, and fades back in as it lands, so the tile's
 * content crossfades with the view's instead of cutting (components/today/tips/TipView.tsx).
 */
export function TipFace({ tips, index }: { tips: BoardTip[]; index: number }) {
  const tip = tips[index];
  if (!tip) return null;
  return <>
    <Quote />
    <div className={styles.stack}><div className={styles.slide}><Slide tip={tip} /></div></div>
    <Dots tips={tips} index={index} />
    {/* The Next button's likeness (the face is a picture: no control in it). */}
    {tips.length > 1 && <span className={`${styles.next} ${styles.nextDisc}`}><NextGlyph /></span>}
  </>;
}

/**
 * The board's tip (2026-10-03): the ivory panel washed with wheat in one corner, a hairline rim
 * running from olive into wheat, the matte grain and a wheat quote mark. The tile keeps the short
 * form: a topic glyph in an olive disc, a short serif headline and one line (clamped to three
 * rows in a narrow column), with the round Next button in its upper corner and the dots under it.
 * Every tip is drawn in the same cell, so the tile is as tall as its longest tip and changing tip
 * never moves the board; the next one slides in from the right through a short blur.
 *
 * Tapping the tile (anywhere but Next) opens the tip's full view in place: the tile is the
 * container that grows into it (components/today/tips/TipStage.tsx). The tips arrive already
 * ordered (lib/today/board.ts `orderTips`), so the tile starts at the first.
 */
export default function TipTile({ tips, onOpen }: {
  tips: BoardTip[];
  /** Opens the tip's full view; `from` is the tile's open control. */
  onOpen?: (tip: BoardTip, from: HTMLElement) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [offset, setOffset] = useState(0);
  const liveId = useId();
  if (tips.length === 0) return null;
  const count = tips.length;
  const index = offset % count;
  const previous = (index - 1 + count) % count;
  const tip = tips[index];
  const leaving = reduce ? INSTANT : { x: SPRINGS.smooth, opacity: FADES.quick, filter: FADES.quick };
  const arriving = reduce ? INSTANT
    : { x: SPRINGS.smooth, filter: FADES.base, opacity: { ...FADES.base, delay: 0.04 } };

  return <motion.div className={`matte-grain ${styles.surface} ${styles.tip}`} data-source={tip.source} data-tip-tile=""
    style={TIP_CORNER} layoutId={reduce || !onOpen ? undefined : TIP_LAYOUT_ID}
    transition={reduce ? INSTANT : BOARD_MORPH.frame}>
    <Quote />
    <div className={styles.stack} aria-hidden="true">
      {tips.map((item, i) => {
        const shown = i === index;
        return <motion.div key={item.id} className={styles.slide} data-current={shown || undefined}
          initial={false}
          animate={shown ? { opacity: 1, x: 0, filter: "blur(0px)" }
            : { opacity: 0, x: i === previous ? -14 : 14, filter: "blur(4px)" }}
          transition={shown ? arriving : leaving}>
          <Slide tip={item} />
        </motion.div>;
      })}
    </div>
    <Dots tips={tips} index={index} />
    <p id={liveId} className="sr-only" aria-live="polite" aria-atomic="true">{spoken(tip, index, count)}</p>
    {/* The whole tile opens the tip; Next sits above this control in its own corner. */}
    {onOpen && <button type="button" className={styles.open} {...{ [TIP_OPEN_ATTR]: tip.id }}
      aria-label={`Open tip: ${tip.title ?? tip.text}`}
      onClick={(event) => onOpen(tip, event.currentTarget)} />}
    {/* The system's small secondary circle: 36 px to see, 44 px to hit (DESIGN.md §Buttons). Not the
        primary: paging tips completes nothing, and the board's one primary is "mark eaten". */}
    {count > 1 && <Button variant="secondary" shape="circle" size="sm" className={styles.next} aria-label="Next tip"
      aria-controls={liveId} onClick={() => setOffset((n) => n + 1)}>
      <NextGlyph />
    </Button>}
  </motion.div>;
}
