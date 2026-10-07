"use client";

import { AnimatePresence } from "motion/react";
import Fold from "@/components/ui/Fold";
import RuleMark from "@/components/ui/RuleMark";
import type { FoodComponent, ResolvedSlot, RuleMark as RuleMarkValue } from "@/lib/types";

type MarkedSlot = Pick<ResolvedSlot, "components" | "componentRuleMarks" | "eaten">;

/**
 * Each shown ingredient line's mark against the account's current food rules (resolveDay's
 * `componentRuleMarks`, one per `components` line). The lines resolveDay judged are read by position;
 * an edited list (a draft in the card, the edit sheet's working copy) is read by name, since a line's
 * mark follows its food's name. A line the draft added has no mark until the next resolve. Eaten
 * lines are history and are never marked; a missing field reads as no mark.
 */
export function lineRuleMarks(slot: MarkedSlot, shown: readonly FoodComponent[]): (RuleMarkValue | null)[] {
  const marks = slot.componentRuleMarks ?? [];
  if (slot.eaten) return shown.map(() => null);
  if (shown === slot.components) return shown.map((_, index) => marks[index] ?? null);
  const byName = new Map<string, RuleMarkValue>();
  slot.components.forEach((component, index) => {
    const mark = marks[index];
    if (mark && !byName.has(component.name)) byName.set(component.name, mark);
  });
  return shown.map((component) => byName.get(component.name) ?? null);
}

/**
 * The card's own line: the slot's worst mark, shown in the tray while the ingredients are folded.
 * Open, each line carries its own mark, so the card line steps aside unless no line has one (an
 * accepted recipe with no lines still carries its recipe's verdict).
 */
export function slotRuleMark(slot: MarkedSlot & Pick<ResolvedSlot, "ruleMark">,
  expanded: boolean): RuleMarkValue | null {
  if (slot.eaten || !slot.ruleMark) return null;
  if (expanded && lineRuleMarks(slot, slot.components).some(Boolean)) return null;
  return slot.ruleMark;
}

/** The slot's mark at the top of the card's beige tray: ink on beige, clear of the hero. */
export function SlotRuleMarkLine({ mark }: { mark: RuleMarkValue | null }) {
  return <AnimatePresence initial={false}>
    {mark && <Fold key="rule-mark">
      <div data-slot-rule-mark={mark.verdict} className="pt-3 pb-2"><RuleMark mark={mark} /></div>
    </Fold>}
  </AnimatePresence>;
}
