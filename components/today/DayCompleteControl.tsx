"use client";

/**
 * "I logged everything I ate today": the user's own statement that the viewed day's food log is
 * complete (TDEE step E6, UI pass 2026-10-04 item X1). It writes `plan_days.day_complete_at`
 * through `saveDayComplete`, the ordinary local-first `plan_days` op, so it works offline and
 * reaches the account's other devices with the next sync; tapping again clears it.
 *
 * Why the hint line matters (ruling R3, docs/decisions/2026-10-04-adaptive-handoff-rulings.md):
 * until an account marks its first day, days with complete calorie data teach the burn estimate;
 * from then on only marked days do, and clearing a mark never restores the old rule.
 *
 * It shows for today and earlier days that have something logged (or already carry the mark, so a
 * mark can always be cleared). A day with nothing logged gets no control: a mark there teaches
 * nothing and would only switch the account onto the marked-days rule by accident.
 *
 * W142: before the first tap that marks a day, a Jev check on the day's counts and hours (never a
 * name or a note) may ask once, "This day may be missing a meal. Mark it fully logged anyway?". It
 * is fetched ahead, so a tap never waits on it; any failure or a slow answer means no question. The
 * mark stays the user's statement (R3).
 *
 * A quiet row on the ground, not a card: it closes the day's list and must not outweigh the meal
 * cards or "Add a meal" (Kimi audit 2026-10-04, finding 11).
 */
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { Check } from "lucide-react";
import Fold from "@/components/ui/Fold";
import Notice from "@/components/ui/Notice";
import { useActionFeedback } from "@/components/ui/ActionFeedback";
import { spring } from "@/lib/design/motion";
import { currentAccountOrNull } from "@/lib/device/account";
import {
  DAY_NUDGE_BODY, DAY_NUDGE_TITLE, dayCompletenessState, type DayCompletenessState,
} from "@/lib/day-completeness";
import { fetchDayNudge } from "@/lib/day-completeness-client";
import { saveDayComplete } from "@/lib/plan-day-mark";
import { getDay } from "@/lib/store";
import type { StoredDay } from "@/lib/types";

/** "From your first mark on" carries the one-way rule (R3) without a number, and stays true
 *  whether or not this account has marked yet (Kimi audit 2026-10-04, findings 9 and 10). */
export const DAY_COMPLETE_HINT = "From your first mark on, only marked days teach your burn estimate.";

/** A ticked meal or a logged entry: the day has food on it to vouch for. */
export function hasLoggedFood(day: StoredDay | undefined): boolean {
  return Object.values(day?.eaten ?? {}).some(Boolean) || (day?.extras?.length ?? 0) > 0;
}

/** Today or earlier, with food logged or the mark already set. ISO dates compare as strings. */
export function showsDayComplete(day: StoredDay | undefined, date: string, today: string): boolean {
  if (date > today) return false;
  return Boolean(day?.dayCompleteAt) || hasLoggedFood(day);
}

export function dayCompleteLabel(date: string, today: string): string {
  return date === today ? "I logged everything I ate today" : "I logged everything I ate that day";
}

export type DayCompleteControlProps = {
  /** The viewed date and the phone's own today, both `YYYY-MM-DD`. */
  date: string;
  today: string;
  /** Seams for tests and the design gallery; the app reads the local store and sends the op. */
  readDay?: (date: string) => StoredDay | undefined;
  save?: (date: string, complete: boolean) => Promise<StoredDay>;
  /** Seam for tests: the day-completeness nudge check. */
  checkNudge?: (state: DayCompletenessState) => Promise<boolean>;
  /** How long the day must sit unchanged before the check is asked (tests pass 0). */
  nudgeSettleMs?: number;
};

const NUDGE_SETTLE_MS = 500;

export default function DayCompleteControl({ date, today, readDay = getDay,
  save = saveDayComplete, checkNudge = fetchDayNudge, nudgeSettleMs = NUDGE_SETTLE_MS }: DayCompleteControlProps) {
  const feedback = useActionFeedback();
  const reduce = useReducedMotionConfig();
  const id = useId().replace(/:/g, "");
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  // The state being written, shown at once; it is dropped when the write settles, so a failure
  // falls back to what the store holds. Kept per date, so switching days never borrows it.
  const [intent, setIntent] = useState<{ date: string; complete: boolean } | null>(null);
  const [failedOn, setFailedOn] = useState<string | null>(null);
  const day = readDay(date);
  const complete = intent?.date === date ? intent.complete : Boolean(day?.dayCompleteAt);
  const visible = intent?.date === date || showsDayComplete(day, date, today);
  const key = `day-complete:${date}`;
  // The day's counts as Jev sees them; the verdict is kept per date and state, so editing the log
  // asks again and switching days never borrows another day's answer.
  const nudgeState = dayCompletenessState(day, date, today);
  const nudgeKey = `${date}|${JSON.stringify(nudgeState)}`;
  const [verdict, setVerdict] = useState<{ key: string; nudge: boolean } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const checkable = visible && !complete && hasLoggedFood(day);
  useEffect(() => {
    if (!checkable) return;
    let current = true;
    // Debounced so paging through days (or editing the log) asks once it settles, not per step.
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => checkNudge(nudgeState)).catch(() => false).then((nudge) => {
        if (current) setVerdict({ key: nudgeKey, nudge });
      });
    }, nudgeSettleMs);
    return () => { current = false; clearTimeout(timer); };
    // The state is a pure function of `nudgeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkable, nudgeKey, checkNudge, nudgeSettleMs]);
  const asked = asking === nudgeKey && verdict?.key === nudgeKey && verdict.nudge;
  // Moving focus to "Mark anyway" is what announces the question to a screen reader.
  const nudgeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (asked) nudgeRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [asked]);
  const control = feedback.controlPropsFor(key);

  async function toggle(skipNudge = false) {
    if (control.disabled) return; // one write at a time; the control stays focusable meanwhile
    const next = !complete;
    if (next && !skipNudge && verdict?.key === nudgeKey && verdict.nudge) {
      setAsking(nudgeKey);
      return;
    }
    setAsking(null);
    const epoch = currentAccountOrNull()?.epoch;
    setIntent({ date, complete: next });
    setFailedOn(null);
    const result = await feedback.run(() => save(date, next), {
      kind: "commit", key,
      failureMessage: next ? "The day was not marked." : "The mark was not cleared.",
      // A write whose account has gone is nobody's to report here.
      stale: () => currentAccountOrNull()?.epoch !== epoch,
    });
    setIntent(null);
    if (!result.ok) setFailedOn(date);
  }

  const failure = failedOn === date && feedback.notice?.tone === "error" ? feedback.notice : null;

  return <AnimatePresence initial={false}>
    {visible && <Fold key="day-complete" className="-mx-4 -my-3">
      {/* Room inside the clip for the focus ring and the success glow; the margin cancels it. */}
      <div className="flex flex-col gap-2 px-4 py-3">
        <button type="button" role="checkbox" aria-checked={complete} aria-labelledby={labelId}
          aria-describedby={hintId}
          // Not `disabled` while pending: that would drop keyboard focus mid-toggle.
          onClick={() => void toggle()} aria-disabled={control.disabled || undefined}
          aria-busy={control["aria-busy"]}
          data-feedback-state={control["data-feedback-state"]}
          className={`tap flex min-h-11 w-full items-center gap-3 rounded-2xl px-1 py-2 text-left ${control.className}`}>
          {/* The empty ring is muted ink (≥ 3:1 on the ground, WCAG 1.4.11); the olive fill grows in
              over it on the control spring and shrinks back out when the mark is cleared. */}
          <span aria-hidden="true" className="relative flex size-7 shrink-0 items-center justify-center
            rounded-full border-[1.5px] border-muted">
            <AnimatePresence initial={false}>
              {complete && <motion.span key="fill"
                className="absolute -inset-[1.5px] [background:var(--grad-ink)] text-on-primary flex items-center justify-center rounded-full"
                initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.4 }} transition={spring("snappy", reduce)}>
                <Check size={16} strokeWidth={2.4} />
              </motion.span>}
            </AnimatePresence>
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span id={labelId} className="text-[16px] font-medium text-charcoal">
              {dayCompleteLabel(date, today)}</span>
            {/* Graphite, not muted: on the oat ground muted ink measures about 4.4:1 at 12 px. */}
            <span id={hintId} className="text-tiny font-normal text-graphite">{DAY_COMPLETE_HINT}</span>
          </span>
        </button>
        <AnimatePresence initial={false}>
          {asked && !complete && <Fold key="nudge">
            <div ref={nudgeRef}><Notice tone="info" title={DAY_NUDGE_TITLE} onDismiss={() => setAsking(null)}
              action={{ label: "Mark anyway", onClick: () => void toggle(true) }}>
              {DAY_NUDGE_BODY}
            </Notice></div>
          </Fold>}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {failure && <Fold key="failure">
            <Notice tone="error" title={failure.message} onDismiss={feedback.dismiss}
              action={{ label: "Try again", onClick: () => void toggle(true) }} />
          </Fold>}
        </AnimatePresence>
      </div>
    </Fold>}
  </AnimatePresence>;
}
