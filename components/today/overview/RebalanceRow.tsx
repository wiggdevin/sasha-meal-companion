"use client";

import CardFrame from "@/components/ui/CardFrame";
import Button from "@/components/ui/Button";
import KcalText from "@/components/ui/KcalText";
import { copyFor } from "@/lib/rebalance/copy";
import type { RebalancePanel } from "@/lib/rebalance/panel";
import type { SlotId } from "@/lib/types";

/**
 * The cockpit's rebalance line (UI makeover §4 item 3): only while the page passes a Phase 19
 * "Rebalance my day" panel to show (`useRebalancePanel`). Read-only: the copy table's headline, its
 * first supporting line, and one "View meal" link to the card it points at (the highlighted one,
 * else the first). It writes nothing, and the full panel stays where it always was.
 */
export default function RebalanceRow({ panel, onOpenSlot }: {
  panel?: RebalancePanel;
  onOpenSlot?: (slot: SlotId) => void;
}) {
  if (!panel?.show) return null;
  const copy = copyFor(panel.copyKey, panel.numbers, panel.cards);
  const card = panel.cards.find((item) => item.highlight) ?? panel.cards[0];
  return <CardFrame size="sm" as="section" aria-label="Rebalance my day"
    title={<KcalText text={copy.headline} />} titleAs="h3"
    meta={copy.sub[0] ? <KcalText text={copy.sub[0]} /> : undefined}
    aside={card && onOpenSlot ? <Button variant="ghost" size="sm" onClick={() => onOpenSlot(card.slot)}
      aria-label={`View meal: ${card.label}`}>View meal</Button> : undefined} />;
}
