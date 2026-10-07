/**
 * The one predicate and the day's numbers for "Rebalance my day" (Phase 19 §5.1, §5.2). Pure.
 * This file is the only place in the panel that compares a day's kcal with its target.
 */
import { slotHasOwnLog } from "@/lib/plan/eaten-estimate";
import type { PanelSlot } from "@/lib/plan/panel-slots";
import { targetDayFor } from "@/lib/targets/revision";
import type { ResolvedDay } from "@/lib/types";
import { intakeEvidence, type IntakeEvidence } from "./intake";
import { clockToMinutes, isMissedSlot, type PanelNow } from "./missed";

export type { IntakeEvidence, IntakeStatus } from "./intake";
export type { PanelNow } from "./missed";

export const BALANCE_TOLERANCE = { minKcal: 100, share: 0.05 } as const;

export type Balance = "over" | "under" | "within";

/** max(100, round(5 % of T)). */
export function toleranceFor(targetKcal: number): number {
  return Math.max(BALANCE_TOLERANCE.minKcal, Math.round(BALANCE_TOLERANCE.share * targetKcal));
}

/** kcal against target: "over" above target + tol, "under" below target − tol, else "within". */
export function balanceOf(kcal: number, targetKcal: number): Balance {
  const tolerance = toleranceFor(targetKcal);
  if (kcal > targetKcal + tolerance) return "over";
  if (kcal < targetKcal - tolerance) return "under";
  return "within";
}

/** The eating end: no meal is planned after 21:30 unless the day already holds a later one. */
export const EATING_END_FLOOR_MINUTES = 21 * 60 + 30;

type BalanceBase = {
  /** T: the revision in force on the day, for its day type; null means `needs_profile`. */
  targetKcal: number | null;
  missed: PanelSlot[];
  remaining: PanelSlot[];
  /** Z, minutes after local midnight: max(latest slot time, 21:30). */
  eatingEndMinutes: number;
  /** W = Z − now, in minutes. */
  windowMinutes: number;
};

/** Intake fully known: `planned` is the plan as it stands; `left` needs a target too. */
export type KnownDayBalance = BalanceBase & {
  intake: IntakeEvidence & { status: "complete" };
  left: number | null;
  planned: number;
};

/** Intake not fully known: no definite left or planned figure. */
export type UnknownDayBalance = BalanceBase & {
  intake: IntakeEvidence & { status: "estimated" | "incomplete" };
  left: null;
  planned: null;
};

export type DayBalance = KnownDayBalance | UnknownDayBalance;

export function isIntakeKnown(balance: DayBalance): balance is KnownDayBalance {
  return balance.intake.status === "complete";
}

/** The device's local day by the one phone rule (`targetDayFor`) and its local clock. */
export function panelNow(at: Date): PanelNow {
  return { date: targetDayFor(at), minutes: at.getHours() * 60 + at.getMinutes() };
}

/**
 * A slot still ahead (the caller has ruled out missed): not eaten, not cleared, and not a slot whose log is its record
 * (no meal, a log filed under it). A planned, uneaten meal with food logged under it stays.
 */
function isRemaining(slot: PanelSlot, day: ResolvedDay): boolean {
  if (slot.eaten || slot.cleared) return false;
  return slot.meal !== null || !slotHasOwnLog(day, slot.slot);
}

/** `day` and `slots` come from the same resolveDay call Today renders from. */
export function dayBalance(day: ResolvedDay, slots: readonly PanelSlot[], now: PanelNow): DayBalance {
  const missed: PanelSlot[] = [];
  const remaining: PanelSlot[] = [];
  for (const slot of slots) {
    if (isMissedSlot(slot, day, now)) missed.push(slot);
    else if (isRemaining(slot, day)) remaining.push(slot);
  }
  const eatingEndMinutes = Math.max(EATING_END_FLOOR_MINUTES,
    ...slots.map((slot) => clockToMinutes(slot.time)));
  const targetKcal = day.targets?.kcal ?? null;
  const base = { targetKcal, missed, remaining, eatingEndMinutes,
    windowMinutes: eatingEndMinutes - now.minutes };
  const intake = intakeEvidence(day, slots);
  if (intake.status !== "complete") {
    return { ...base, intake: { ...intake, status: intake.status }, left: null, planned: null };
  }
  // The remaining cards as shown; missed cards went by and are left out.
  const remainingKcal = remaining.reduce((sum, slot) => sum + slot.macros.kcal, 0);
  return {
    ...base,
    intake: { ...intake, status: "complete" },
    left: targetKcal === null ? null : targetKcal - intake.recordedKcal,
    planned: Math.round(intake.recordedKcal + remainingKcal),
  };
}
