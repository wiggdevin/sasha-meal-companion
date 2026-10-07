/**
 * Phase 19 §6.2: the panel's copy table. DRAFT pending the D6 clinical review — the `under`, `over`,
 * `spent` and `incomplete_intake` text here, and which cards each state highlights (`classifyDay`),
 * must pass that review before anyone outside the `REBALANCE_PANEL_USER_IDS` allowlist can see them
 * (lib/rebalance/panel-client.ts owns the gate). Nothing here says "fix" or "make up for" (R11,
 * AGENTS.md "Offers, not corrections"): the panel names the state and the user's own options.
 *
 * Pure. Every figure comes from the already-decided `RebalancePanelNumbers`/`cards` — this file
 * compares nothing to a target itself (the one-predicate rule, §5.1).
 */
import type { PanelCopyKey, RebalancePanelCard, RebalancePanelNumbers } from "./panel";

export type PanelCopy = { headline: string; sub: readonly string[] };

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

/** The `incomplete_intake` sub-lines, in order, each shown only while it applies (§6.2). */
function incompleteIntakeLines(numbers: RebalancePanelNumbers): string[] {
  const lines: string[] = [];
  if (numbers.recordedKcal > 0) lines.push(`At least ${numbers.recordedKcal} kcal accounted for`);
  const { estimatedSlots, unknownSlots, unknownItems, unknownEntries, partial } = numbers.intake;
  if (estimatedSlots > 0) {
    lines.push(`${estimatedSlots} ${plural(estimatedSlots, "eaten meal is", "eaten meals are")} an estimate`);
  }
  if (unknownSlots > 0) {
    lines.push(`${unknownSlots} ${plural(unknownSlots, "eaten meal has", "eaten meals have")} no calorie record`);
  }
  const unknownLogged = unknownItems + unknownEntries;
  if (unknownLogged > 0) {
    lines.push(`${unknownLogged} ${plural(unknownLogged, "logged food has", "logged foods have")} no calorie value`);
  }
  if (partial) lines.push("A recipe is only partly measured");
  return lines;
}

/** The copy for one state, from its already-decided numbers and cards (never a fresh comparison). */
export function copyFor(
  copyKey: PanelCopyKey,
  numbers: RebalancePanelNumbers,
  cards: readonly RebalancePanelCard[],
): PanelCopy {
  switch (copyKey) {
    case "no_target":
      return { headline: "Set up your targets", sub: [] };
    case "incomplete_intake":
      return { headline: "Intake is not fully known", sub: incompleteIntakeLines(numbers) };
    case "on_track":
      return { headline: "On track", sub: [`${numbers.leftKcal ?? 0} kcal left`] };
    case "under": {
      const missed = cards.find((card) => card.status === "missed");
      return {
        headline: `${numbers.leftKcal ?? 0} kcal left today`,
        sub: missed ? [`${missed.label} went by`] : [],
      };
    }
    case "over": {
      const over = (numbers.plannedKcal ?? 0) - (numbers.targetKcal ?? 0);
      return {
        headline: `Your plan comes to ${over} kcal over`,
        sub: ["You can open a meal below to clear or change it"],
      };
    }
    case "spent": {
      const over = numbers.recordedKcal - (numbers.targetKcal ?? 0);
      return { headline: `${over} kcal past today's target`, sub: ["Tomorrow starts fresh"] };
    }
    case "no_action":
      return { headline: "Nothing left to change today", sub: ["Tomorrow starts fresh"] };
  }
}
