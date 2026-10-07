"use client";

/**
 * The dock's weigh-in (U19, 2026-10-04; owner: "The weight logging entry we need to work on the
 * contrast. Can't see anything on it. And there should be a quick undo button … You just log it, get
 * a confirmation … The input box … could be more fluid UI based and then maybe morph into a few
 * questions after it's logged, so maybe that can be undo, check your trends, see suggestions").
 *
 * Log writes the weight straight through the coach's weight path (weigh-in.ts), never a chat turn.
 * The button confirms in place ("Logged", a tick and a short haptic); then the card morphs, on the
 * gentle spring with the blur swap, into the follow-ups: Undo for eight seconds (the real undo; a
 * failed undo can be tried again inside that window), "Your trend" and "Suggestions", which open the
 * chat over the page with a short ask.
 */
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import AutoHeight from "@/components/ui/AutoHeight";
import Button from "@/components/ui/Button";
import CloseButton from "@/components/ui/CloseButton";
import Notice from "@/components/ui/Notice";
import { CONFIRM_MS, useButtonStatus } from "@/components/ui/useButtonStatus";
import {
  WEIGH_IN_UNDO_MS, coachWeightWriter, parseWeight, type LoggedWeight, type WeightWriter,
} from "@/components/coach/attachments/weigh-in";
import { Swapped, WeighInFollowUps } from "@/components/coach/attachments/WeighInFollowUps";
import type { WeightUnit } from "@/lib/health/units";
import styles from "./WeighInField.module.css";
export type { WeightUnit } from "@/lib/health/units";

export { SUGGESTIONS_ASK, TREND_ASK } from "@/components/coach/attachments/WeighInFollowUps";

type Logged = LoggedWeight & { shown: string };

export default function WeighInField({ unit, disabled, value, onValueChange, onAsk, onClose,
  writer = coachWeightWriter }: {
  unit: WeightUnit;
  disabled?: boolean;
  /** Held by the dock, so a number typed and then closed is still there next time. */
  value: string;
  onValueChange: (value: string) => void;
  /** A follow-up that asks the assistant (the dock opens the chat over the page). */
  onAsk: (text: string) => void;
  onClose: () => void;
  writer?: WeightWriter;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const undoButton = useRef<HTMLButtonElement | null>(null);
  const trendButton = useRef<HTMLButtonElement | null>(null);
  const log = useButtonStatus();
  const undo = useButtonStatus();
  const [hint, setHint] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [logged, setLogged] = useState<Logged | null>(null);
  const [phase, setPhase] = useState<"entry" | "after">("entry");
  const [undoOpen, setUndoOpen] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (ms: number, run: () => void) => { timers.current.push(setTimeout(run, ms)); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (phase === "after") (undoButton.current ?? trendButton.current)?.focus({ preventScroll: true });
    else input.current?.focus({ preventScroll: true });
  }, [phase]);

  async function submit(): Promise<void> {
    if (disabled || log.status !== "idle") return;
    const parsed = parseWeight(value, unit);
    if ("hint" in parsed) {
      setHint(parsed.hint);
      input.current?.animate?.([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" },
        { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 150 });
      return;
    }
    setFailure(null);
    const shown = `${value.trim().replace(",", ".")} ${unit}`;
    const result = await log.run(() => writer.log(parsed.kg));
    if (!result.ok) {
      setFailure(result.error instanceof Error ? result.error.message : "That weight did not save. Try again.");
      return;
    }
    setLogged({ ...result.value, shown });
    onValueChange("");
    // The button holds its "Logged" for its usual beat, then the card turns into the follow-ups.
    later(CONFIRM_MS, () => { setPhase("after"); setUndoOpen(true); });
    later(CONFIRM_MS + WEIGH_IN_UNDO_MS, closeUndo);
  }

  /** The undo window has passed: Undo leaves, and focus on it moves to the next follow-up. An undo
   *  still running keeps it until that answer is in. */
  const windowOver = useRef(false);
  const undoing = useRef(false);
  function closeUndo(): void {
    windowOver.current = true;
    if (undoing.current) return;
    if (undoButton.current && undoButton.current === document.activeElement) trendButton.current?.focus();
    setUndoOpen(false);
  }

  async function undoLog(): Promise<void> {
    if (!logged || undoing.current) return;
    setFailure(null);
    undoing.current = true;
    const result = await undo.run(() => writer.undo(logged.token));
    undoing.current = false;
    if (!result.ok) {
      // A failed undo can be tried again for as long as its window lasts (Sol review S5): the button
      // says "Try again" and the notice says why; once the window is over, Undo leaves as usual.
      setFailure(result.error instanceof Error ? result.error.message : "Undo did not save.");
      if (windowOver.current) closeUndo();
      return;
    }
    const back = logged.shown.replace(` ${unit}`, "");
    later(CONFIRM_MS, () => { onValueChange(back); setLogged(null); setUndoOpen(false); setPhase("entry"); });
  }

  return <div className={`matte-reset relative ${styles.card}`} role="group" aria-label="Weigh in">
    <AutoHeight spring="gentle">
      <AnimatePresence initial={false} mode="popLayout">
        {phase === "entry" ? <Swapped key="entry"><form className={styles.entry} noValidate
          onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor={id} className="shrink-0 text-caption font-medium text-graphite">Weight</label>
          <div className={`field min-w-0 flex-1 ${hint ? styles.invalid : ""}`.trim()}>
            <input id={id} ref={input} type="text" inputMode="decimal" enterKeyHint="done" autoComplete="off"
              aria-label={`Weight in ${unit}`} aria-invalid={hint !== null}
              aria-describedby={hint ? `${id}-hint` : undefined}
              value={value} disabled={disabled}
              onChange={(event) => { onValueChange(event.target.value); setHint(null); }}
              className={`field-input text-title font-semibold ${styles.input}`} />
            <span className="pr-2 text-caption text-muted" aria-hidden="true">{unit}</span>
          </div>
          <Button type="submit" variant="primary" disabled={disabled} status={log.status}
            confirmLabel="Logged">Log</Button>
          <CloseButton label="Close weigh-in" onClick={onClose} />
        </form></Swapped>
        : <Swapped key="after" className={styles.after}><WeighInFollowUps shown={logged?.shown} note={logged?.note} undoOpen={undoOpen}
          undoRef={undoButton} trendRef={trendButton} undoStatus={undo.status}
          onUndo={() => void undoLog()} onAsk={onAsk} onClose={onClose} /></Swapped>}
      </AnimatePresence>
    </AutoHeight>
    {(hint || failure) && <div className="px-2 pb-2">
      {hint ? <p id={`${id}-hint`} role="alert" className="m-0 px-2 text-tiny text-red-ink">{hint}</p>
        : <Notice tone="error" title={failure ?? ""} />}
    </div>}
  </div>;
}
