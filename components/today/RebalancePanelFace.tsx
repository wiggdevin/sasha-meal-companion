"use client";
/**
 * The live widget's "rebalance" face: the collapsed line, the bubble glyph and the full panel.
 * Kept out of components/today/LiveWidget.tsx and LiveWidgetPanels.tsx (shared with
 * feat/ui-glass-well's restyle) so each of those needs only one line per face to call this.
 */
import Ring from "@/components/today/island/Ring";
import RebalancePanel from "@/components/today/RebalancePanel";
import { copyFor } from "@/lib/rebalance/copy";
import type { RebalancePanel as RebalancePanelData } from "@/lib/rebalance/panel";
import type { SlotId } from "@/lib/types";
import styles from "@/components/today/island/Island.module.css";

function headlineOf(panel: RebalancePanelData | undefined): string {
  return panel?.show ? copyFor(panel.copyKey, panel.numbers, panel.cards).headline : "Rebalance my day";
}

/** The widget toggle's spoken line for this face. */
export function rebalanceSpoken(panel: RebalancePanelData | undefined): string {
  if (!panel?.show) return "Rebalance my day: nothing to show yet";
  const copy = copyFor(panel.copyKey, panel.numbers, panel.cards);
  return [copy.headline, ...copy.sub].join(". ");
}

/** Collapsed: the panel's headline beside the orb, like every other panel's one-liner. */
export function RebalanceCompact({ panel }: { panel: RebalancePanelData | undefined }) {
  return <span className={styles.compactLine}>
    <span className={styles.word}>{headlineOf(panel)}</span>
  </span>;
}

/** A bubble beside the island: tone only (the quiet mark, or a nudge mark), at a glance. */
export function RebalanceBubble({ panel }: { panel: RebalancePanelData | undefined }) {
  const nudge = panel?.show === true && panel.tone === "nudge";
  return <Ring share={1} size={46} stroke={3} colorClass={styles.arcCurrent}>
    <span className={styles.bubbleText}>{nudge ? "!" : "R"}</span>
  </Ring>;
}

/** Expanded: the real read-only panel, risen through the glass. */
export function RebalanceFull({ panel, onOpenSlot }: {
  panel: RebalancePanelData | undefined;
  onOpenSlot?: (slot: SlotId) => void;
}) {
  if (!panel?.show) return null;
  return <RebalancePanel panel={panel} onOpenSlot={onOpenSlot ?? (() => {})} />;
}
