"use client";

import { useState } from "react";
import { motion, useReducedMotionConfig } from "motion/react";
import type { BoardTip } from "@/lib/today/board";
import { INSTANT } from "@/lib/design/motion";
import TipGlyph, { glyphOf } from "@/components/today/tips/TipGlyph";
import { BOARD_MORPH } from "@/components/today/useDayCardMotion";
import { TIP_CORNER, TIP_LAYOUT_ID, TIP_OPEN_ATTR } from "@/components/today/tips/shared";
import { ChevronIcon } from "@/components/ui/icons";
import styles from "@/components/today/TipTile.module.css";

/** The row's one line: the headline, or the summary for a tip without one. */
export function tipLine(tip: BoardTip): string {
  return tip.title ?? tip.text;
}

/** What the row says to assistive tech: whose tip it is and its line. */
function spoken(tip: BoardTip): string {
  return `${tip.source === "coach" ? "From your coach" : "Tip"}: ${tipLine(tip)}`;
}

/** The row's content: a 16 px line glyph, one line of text and the chevron. */
function Row({ tip }: { tip: BoardTip }) {
  return <>
    <span className={styles.rowGlyph} aria-hidden="true"><TipGlyph glyph={glyphOf(tip)} size={16} /></span>
    <span className={styles.line}>
      {tip.source === "coach" && <span className={styles.source}>Coach · </span>}
      {tipLine(tip)}
    </span>
    <span className={styles.chevron} aria-hidden="true"><ChevronIcon direction="right" size={16} /></span>
  </>;
}

/**
 * The row as drawn at rest, without its control: what the full view carries at the row's own size
 * while it grows out of the row and fades, and fades back in as it lands, so the row's content
 * crossfades with the view's instead of cutting (components/today/tips/TipView.tsx).
 */
export function TipFace({ tips, index }: { tips: BoardTip[]; index: number }) {
  const tip = tips[index];
  if (!tip) return null;
  return <Row tip={tip} />;
}

/**
 * The board's tip (redesign v4, 2026-10-08, brief §5 Tier 3): a plain 44 px row, no card chrome —
 * a line glyph, the tip's headline on one line and a chevron. Tapping it opens the tip's full view
 * in place: the row is the container that grows into it (components/today/tips/TipStage.tsx).
 *
 * The tips arrive already ordered by what matters on the viewed day (lib/today/board.ts
 * `orderTips`, which also rotates them once a day), so the row shows the first. It holds that tip by
 * id, not position: the tips reorder as the day changes (a first cup drops the water tip's
 * relevance), and the row must not switch tips on its own while it is on screen.
 */
export default function TipTile({ tips, onOpen }: {
  tips: BoardTip[];
  /** Opens the tip's full view; `from` is the row's open control. */
  onOpen?: (tip: BoardTip, from: HTMLElement) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const [shownId] = useState<string | null>(() => tips[0]?.id ?? null);
  if (tips.length === 0) return null;
  const tip = tips.find((item) => item.id === shownId) ?? tips[0];

  return <motion.div className={styles.tip} data-source={tip.source} data-tip-tile=""
    style={TIP_CORNER} layoutId={reduce || !onOpen ? undefined : TIP_LAYOUT_ID}
    transition={reduce ? INSTANT : BOARD_MORPH.frame}>
    {onOpen
      ? <button type="button" className={`tap ${styles.open}`} {...{ [TIP_OPEN_ATTR]: tip.id }}
        aria-label={`Open tip: ${tipLine(tip)}`} onClick={(event) => onOpen(tip, event.currentTarget)}>
        <Row tip={tip} />
      </button>
      : <p className={styles.still}><span className="sr-only">{spoken(tip)}</span>
        <span className={styles.stillRow} aria-hidden="true"><Row tip={tip} /></span></p>}
  </motion.div>;
}
