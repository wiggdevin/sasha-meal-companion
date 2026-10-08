/**
 * Pure day-type toggle logic for the Today header (T5). The mapping lives
 * here so the tap is testable without a DOM; the writes live in
 * lib/plan-day-client.ts.
 *
 * The sheet always offers the same three rows — the date's training variant,
 * rest, and "follow the schedule" — so the rows never move under their finger.
 * The check follows the day type in force, never the presence of an override:
 * a locked rest day still reads "Rest day".
 */
import type { DayType } from "./types";

export type DayTypeChoice = {
  kind: "type" | "clear";
  id: "training" | "rest" | "clear";
  label: string;
  /** The override this row writes; `null` clears it. */
  dayType: DayType | null;
  /** True for the row naming the day type in force — the sheet's check mark. */
  current: boolean;
  /** The line under the label. */
  note: string;
};

const TRAINING_LABEL = "Training day";
const REST_LABEL = "Rest day";
const CLEAR_LABEL = "Follow the schedule";

/** The line under each type. The fasted variant survives only on a date the account saved it. */
const TYPE_NOTE: Record<DayType, string> = {
  "training-10": "Usual slot times",
  "training-7-fasted": "Fasted 7am session",
  rest: "Slots and targets follow a rest day",
};

/**
 * The training day a row offers: always `training-10`. Wednesday's fasted 7am variant was the
 * first client's week (onboarding v2 G6); no account is offered it by weekday. `date` stays in
 * the signature for the callers.
 */
export function trainingDayTypeFor(date: string): DayType {
  void date;
  return "training-10";
}

/**
 * The sheet's three rows, always in this order. `dayType` is the resolved day
 * (an override wins), so `current` lands on the row the user is looking at.
 */
export function dayTypeChoices(dayType: DayType, date: string, locked: boolean): DayTypeChoice[] {
  // A fasted session this date already saved stays the training row; nothing new offers it.
  const training = dayType === "training-7-fasted" ? dayType : trainingDayTypeFor(date);
  return [
    {
      kind: "type",
      id: "training",
      label: TRAINING_LABEL,
      dayType: training,
      current: dayType !== "rest",
      note: TYPE_NOTE[training],
    },
    {
      kind: "type",
      id: "rest",
      label: REST_LABEL,
      dayType: "rest",
      current: dayType === "rest",
      note: TYPE_NOTE.rest,
    },
    {
      kind: "clear",
      id: "clear",
      label: CLEAR_LABEL,
      dayType: null,
      current: false,
      note: locked ? "Puts this date back on the schedule" : "This date is on the schedule",
    },
  ];
}

/**
 * Whether tapping a row is worth a write. The row for the type already in
 * force, and "follow the schedule" with nothing pinned, are both no-ops:
 * there is nothing to change, so the sheet just closes.
 */
export function dayTypeChoiceChanges(
  choice: DayTypeChoice,
  dayType: DayType,
  locked: boolean,
): boolean {
  if (choice.kind === "clear") return locked;
  return choice.dayType !== dayType;
}

/** What a row tap should do next: nothing, write the day, or just close the sheet. */
export type ChoiceAction = "ignore" | "save" | "close";

/** Everything the tap decision reads: the in-flight gate and the day currently in force. */
export type DayTypeChoiceState = {
  /** True from the tap that starts a save until that save settles, success or failure. */
  saving: boolean;
  dayType: DayType;
  locked: boolean;
};

/**
 * The whole decision a row tap makes, as one pure step.
 *
 * A tap that lands while a save is still in flight is **ignored**. `savePlanDay`
 * is awaited, so between the first tap and the write settling the props the
 * sheet rendered with still describe the old day: a second tap ("Rest day",
 * then "Follow the schedule") would be judged against the stale `dayType`,
 * dropped as a no-op, and then the first write would land anyway — or, tap by
 * tap, queue a second op for the same date. The gate closes that window; the
 * rows are also `disabled` while saving, so this is the second lock.
 */
export function nextChoiceAction(state: DayTypeChoiceState, choice: DayTypeChoice): ChoiceAction {
  if (state.saving) return "ignore";
  return dayTypeChoiceChanges(choice, state.dayType, state.locked) ? "save" : "close";
}

/**
 * Single-flight gate for the sheet's save, held in a ref by the component.
 * `claim()` is synchronous, so a second tap in the same event loop sees the
 * gate shut before React has re-rendered; `release()` runs in the caller's
 * `finally`, so a rejected save frees the rows for a retry.
 */
export type ChoiceGate = {
  saving: () => boolean;
  claim: () => void;
  release: () => void;
};

export function createChoiceGate(): ChoiceGate {
  let saving = false;
  return {
    saving: () => saving,
    claim: () => { saving = true; },
    release: () => { saving = false; },
  };
}

/**
 * Chip copy. Without an override it is the weekday's own label, exactly as
 * the chip read before T5; with one it names the lock — protein never moves
 * (PRD §7.5), so only the calorie side follows.
 */
export function dayTypeLabel(dayType: DayType, override: DayType | undefined): string {
  if (!override) {
    if (dayType === "training-7-fasted") return "Training \u00b7 fasted 7am";
    return dayType === "rest" ? REST_LABEL : TRAINING_LABEL;
  }
  return override === "rest" ? "Locked as a rest day" : "Locked as a training day";
}

/** The day type in the chip's own words, for the accessible name. */
const SPOKEN_LABEL: Record<DayType, string> = {
  "training-10": "training day",
  "training-7-fasted": "fasted training day",
  rest: "rest day",
};

/**
 * The chip's accessible name. The visible label alone cannot carry the lock —
 * it is a glyph — so the name states the day type, whether it is pinned, and
 * what the button does.
 */
export function dayTypeChipName(dayType: DayType, locked: boolean): string {
  const state = locked ? "locked" : "on the schedule";
  return `Day type: ${SPOKEN_LABEL[dayType]}, ${state}. Change`;
}

/**
 * One line naming the day's current state — the "Now: ..." hint in the sheet
 * and, when locked, the reminder that only the calorie side moved.
 */
export function dayTypeNowNote(dayType: DayType, locked: boolean): string {
  if (locked) return `${dayTypeLabel(dayType, dayType)} \u2014 calories follow.`;
  return `${dayTypeLabel(dayType, undefined)} on the schedule`;
}
