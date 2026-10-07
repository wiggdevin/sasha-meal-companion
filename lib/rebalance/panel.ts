/**
 * Phase 19 §6: the "Rebalance my day" panel's data contract, assembled from R1's pure outputs
 * (`projectPanelSlots`, `dayBalance`, `classifyDay`). Pure. This file decides no over/under/within
 * state itself — that is `classifyDay`'s job, which already called `balanceOf` — it only shapes the
 * numbers and cards the copy table and the component read.
 */
import type { PanelSlot } from "@/lib/plan/panel-slots";
import type { ResolvedDay, SlotId } from "@/lib/types";
import { isIntakeKnown, type DayBalance, type IntakeEvidence } from "./balance";
import type { PanelState, PanelStateName } from "./classify";

/** Every `PanelStateName` but `hidden`, which the panel answers with `{ show: false }` instead. */
export type PanelCopyKey = Exclude<PanelStateName, "hidden">;

export type RebalancePanelCard = {
  slot: SlotId;
  label: string;
  time: string;
  kcal: number;
  status: "missed" | "remaining";
  highlight: boolean;
};

export type RebalancePanelNumbers = {
  targetKcal: number | null;
  /** §5.2: never `day.consumed.kcal`. */
  recordedKcal: number;
  /** Null unless `intake.status` is `"complete"`. */
  leftKcal: number | null;
  /** Null unless `intake.status` is `"complete"`. */
  plannedKcal: number | null;
  intake: Omit<IntakeEvidence, "recordedKcal">;
  proteinTargetG: number | null;
  /** `day.consumed.protein`, only when `intake.status` is `"complete"`. */
  proteinConsumedG: number | null;
};

export type RebalancePanel =
  | { show: false }
  | {
      show: true;
      state: PanelCopyKey;
      tone: "quiet" | "nudge";
      copyKey: PanelCopyKey;
      numbers: RebalancePanelNumbers;
      cards: RebalancePanelCard[];
    };

const NUDGE_STATES: ReadonlySet<PanelCopyKey> = new Set(["under", "over", "spent"]);

/** Tone per §6.2: a nudge for under, over and spent; quiet otherwise, `incomplete_intake` included. */
export function toneFor(state: PanelCopyKey): "quiet" | "nudge" {
  return NUDGE_STATES.has(state) ? "nudge" : "quiet";
}

function cardFor(slot: PanelSlot, status: "missed" | "remaining",
  highlighted: ReadonlySet<SlotId>): RebalancePanelCard {
  return {
    slot: slot.slot,
    label: slot.label,
    time: slot.time,
    kcal: Math.round(slot.macros.kcal),
    status,
    highlight: highlighted.has(slot.slot),
  };
}

const EMPTY_INTAKE: Omit<IntakeEvidence, "recordedKcal"> = {
  status: "incomplete", estimatedSlots: 0, unknownSlots: 0, unknownItems: 0, unknownEntries: 0, partial: false,
};

/**
 * Assembles §6's `RebalancePanel` from the classifier's state and R1's `DayBalance`. `day` supplies
 * the protein figures the balance does not carry; it may be omitted for a `hidden` or a hand-built
 * `no_target` panel, in which case the protein figures read null.
 */
export function buildRebalancePanel(
  panelState: PanelState,
  balance: DayBalance | null,
  day: ResolvedDay | null = null,
): RebalancePanel {
  if (panelState.state === "hidden") return { show: false };
  const state = panelState.state as PanelCopyKey;
  const highlighted = new Set(panelState.highlights);
  const cards: RebalancePanelCard[] = balance
    ? [
      ...balance.missed.map((slot) => cardFor(slot, "missed", highlighted)),
      ...balance.remaining.map((slot) => cardFor(slot, "remaining", highlighted)),
    ]
    : [];
  const known = balance !== null && isIntakeKnown(balance);
  const { recordedKcal: _recordedKcal, ...intakeRest } = balance?.intake ?? { recordedKcal: 0, ...EMPTY_INTAKE };
  void _recordedKcal;
  const numbers: RebalancePanelNumbers = {
    targetKcal: balance?.targetKcal ?? null,
    recordedKcal: balance?.intake.recordedKcal ?? 0,
    leftKcal: known ? (balance as Extract<DayBalance, { intake: { status: "complete" } }>).left : null,
    plannedKcal: known ? (balance as Extract<DayBalance, { intake: { status: "complete" } }>).planned : null,
    intake: intakeRest,
    proteinTargetG: day?.targets?.protein ?? null,
    proteinConsumedG: known ? day?.consumed.protein ?? null : null,
  };
  return { show: true, state, tone: toneFor(state), copyKey: state, numbers, cards };
}
