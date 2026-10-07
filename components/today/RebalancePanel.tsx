"use client";
/**
 * Phase 19 R2: the read-only "Rebalance my day" panel (spec §6, §6.1). Headline and sub come from
 * the copy table (lib/rebalance/copy.ts, draft pending the D6 clinical review). Each listed card —
 * missed or remaining, empty or planned, focus or standard — carries exactly one "View meal" link
 * to its Today card. That is the only thing the panel ever does: no action list, no writer, no
 * override, and no claim that its cards or its missed label match `SlotCard`'s own (§6.1).
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Button from "@/components/ui/Button";
import KcalText from "@/components/ui/KcalText";
import { formatTime } from "@/components/SlotCard";
import { SWAP, spring } from "@/lib/design/motion";
import { copyFor } from "@/lib/rebalance/copy";
import type { RebalancePanel as RebalancePanelData } from "@/lib/rebalance/panel";
import type { SlotId } from "@/lib/types";

export type RebalancePanelProps = {
  panel: RebalancePanelData;
  /** UI-owned: takes the user to that slot's Today card. Never a writer. */
  onOpenSlot: (slot: SlotId) => void;
};

/** The one state whose headline carries a link (to onboarding), rather than a plain figure. */
const SET_UP = "Set up";

function Headline({ text }: { text: string }) {
  if (text.startsWith(SET_UP)) {
    return <>
      <a href="/onboarding" className="underline">{SET_UP}</a>{text.slice(SET_UP.length)}
    </>;
  }
  return <KcalText text={text} />;
}

function CardRow({ card, onOpenSlot }: {
  card: Extract<RebalancePanelData, { show: true }>["cards"][number];
  onOpenSlot: (slot: SlotId) => void;
}) {
  return <li data-rebalance-card={card.slot} data-rebalance-highlight={card.highlight || undefined}
    className="flex min-h-11 min-w-0 items-center justify-between gap-3">
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-caption font-medium text-charcoal">
        {card.status === "missed" ? `${card.label} went by` : card.label}
      </span>
      <span className="text-tiny tabular-nums text-muted">
        <KcalText text={`${formatTime(card.time)} · ${card.kcal} kcal`} />
      </span>
    </span>
    <Button variant="ghost" size="sm" onClick={() => onOpenSlot(card.slot)}>View meal</Button>
  </li>;
}

export default function RebalancePanel({ panel, onOpenSlot }: RebalancePanelProps) {
  const reduce = useReducedMotion();
  if (!panel.show) return null;
  const copy = copyFor(panel.copyKey, panel.numbers, panel.cards);
  return <section aria-label="Rebalance my day" data-rebalance-state={panel.state}
    className="flex min-w-0 flex-col gap-3">
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={panel.state} className="flex min-w-0 flex-col gap-1"
        initial={reduce ? false : SWAP.hidden} animate={SWAP.shown}
        exit={reduce ? undefined : SWAP.hidden} transition={spring("smooth", reduce)}>
        <p className="m-0 text-caption font-semibold text-charcoal"><Headline text={copy.headline} /></p>
        {copy.sub.map((line, index) => (
          <p key={index} className="m-0 text-caption text-muted"><KcalText text={line} /></p>
        ))}
      </motion.div>
    </AnimatePresence>
    {panel.cards.length > 0 && <ul className="flex min-w-0 flex-col gap-1">
      {panel.cards.map((card) => <CardRow key={card.slot} card={card} onOpenSlot={onOpenSlot} />)}
    </ul>}
  </section>;
}
