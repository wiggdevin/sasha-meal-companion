"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { confirmHaptic } from "@/lib/haptics";
import Toast from "@/components/ui/Toast";
import styles from "./ActionFeedback.module.css";

export type ActionFeedbackPhase = "idle" | "pending" | "success" | "changed" | "failed";
export type ActionFeedbackTone = "success" | "changed" | "error";
export type ActionFeedbackNotice = {
  tone: ActionFeedbackTone;
  message: string;
  action?: { label: string; action: () => void };
};
export type ActionFeedbackOptions = {
  kind: "commit" | "change";
  successMessage?: string;
  /**
   * Where a success is confirmed (2026-10-04, owner: "the button itself did that thing, so we don't
   * have to do toast notifications"). "control" (the default): the initiating control confirms in
   * place — a `Button` draws its tick and verb, any other control its sage ring — and no toast shows
   * unless the write offers an Undo, which needs a home. "notice": also show `successMessage` as a
   * toast, for a write whose control has gone by the time it lands.
   */
  confirm?: "control" | "notice";
  failureMessage?: string | ((error: unknown) => string);
  undo?: { label?: string; action: () => void };
  /** The stable id of the control that started this write; only that control lights. */
  key?: string;
  /** Wait for a write already in flight rather than joining it: two edits, two outcomes. */
  queue?: boolean;
  /** True when the outcome is not this screen's to report (its account has gone, or nothing was
   *  sent): the write then settles quietly — no notice, glow or haptic. */
  stale?: () => boolean;
};
export type ActionFeedbackResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export const COMMIT_FEEDBACK_MS = 1_600;
const CHANGE_MS = 4_000;
const NOTICE_MS = 5_000;
const DEFAULT_FAILURE = "That did not save. Try again.";

/**
 * The control half of the contract for a phase an owner hands down (Today's slot cards, a logged
 * entry): the shared class, the state attribute the CSS colours, and busy while pending.
 */
export function feedbackStateProps(phase: ActionFeedbackPhase | undefined) {
  const state = phase && phase !== "idle" ? phase : undefined;
  return {
    className: styles.control,
    "data-feedback-state": state,
    "aria-busy": state === "pending" ? true : undefined,
  } as const;
}

export function useActionFeedback() {
  const [phase, setPhase] = useState<ActionFeedbackPhase>("idle");
  const [notice, setNotice] = useState<ActionFeedbackNotice | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRun = useRef<Promise<ActionFeedbackResult<unknown>> | null>(null);
  /** The notice on screen, read synchronously: an error stays until dismissed (queued writes too). */
  const shown = useRef<ActionFeedbackNotice | null>(null);
  /** A standing error shown with a queued success's Undo beside it, mapped back to the error alone. */
  const errorUnder = useRef(new WeakMap<ActionFeedbackNotice, ActionFeedbackNotice>());

  /** Shows a notice; a timed one clears itself only if it is still the one on screen. */
  const show = useCallback((next: ActionFeedbackNotice | null, ms?: number) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    shown.current = next;
    setNotice(next);
    if (next && ms !== undefined) {
      noticeTimer.current = setTimeout(() => {
        if (shown.current !== next) return;
        shown.current = null;
        setNotice(null);
      }, ms);
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    phaseTimer.current = null;
    noticeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const dismiss = useCallback(() => show(null), [show]);

  /**
   * A notice with no write of its own: a confirmation for a write a child committed (and felt)
   * before it closed — no glow, no haptic — or a blocker, which stays until dismissed like a failure.
   */
  const notify = useCallback((next: ActionFeedbackNotice) => {
    show(next, next.tone === "error" ? undefined : next.action ? NOTICE_MS : COMMIT_FEEDBACK_MS);
  }, [show]);

  const run = useCallback(function run<T>(operation: () => Promise<T>, options: ActionFeedbackOptions):
  Promise<ActionFeedbackResult<T>> {
    if (activeRun.current) {
      const active = activeRun.current;
      if (options.queue) return active.then(() => run(operation, options));
      return active as Promise<ActionFeedbackResult<T>>;
    }
    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    phaseTimer.current = null;
    // A queued write is a different write: it never clears another's unexplained failure, which
    // stays until dismissed. A direct retry of the same action starts clean, as before.
    const keepError = options.queue === true && shown.current?.tone === "error";
    if (!keepError) show(null);
    setActiveKey(options.key ?? null);
    setPhase("pending");

    const execution = (async (): Promise<ActionFeedbackResult<T>> => {
      try {
        // Deferring the call one microtask lets activeRun capture synchronous throws too.
        await Promise.resolve();
        // A queued write whose context went while it waited is never sent: it settles quietly.
        if (options.stale?.()) { setPhase("idle"); return { ok: false, error: new Error("Stale write not sent.") }; }
        const value = await operation();
        if (options.stale?.()) { setPhase("idle"); return { ok: true, value }; }
        const nextPhase = options.kind === "commit" ? "success" : "changed";
        const duration = options.kind === "commit" ? COMMIT_FEEDBACK_MS : CHANGE_MS;
        setPhase(nextPhase);
        if (options.kind === "commit") confirmHaptic();
        const toast = options.undo !== undefined || options.confirm === "notice";
        const undo = options.undo ? { label: options.undo.label ?? "Undo", action: options.undo.action } : undefined;
        const current = shown.current;
        const standing = keepError && current?.tone === "error" ? errorUnder.current.get(current) ?? current : null;
        if (toast && options.successMessage && !standing) {
          show({ tone: nextPhase, message: options.successMessage, action: undo }, undo ? NOTICE_MS : duration);
        } else if (toast && options.successMessage && standing && undo && !standing.action) {
          // W139: a success queued behind a standing error still offers its Undo. The error stays
          // on screen with the success beside it for the Undo window, then stands alone again.
          // The Undo puts the error back afterwards: the toast dismisses itself before the action,
          // and the error still stays until the user dismisses it (unless the Undo raised its own).
          const both: ActionFeedbackNotice = { tone: "error", message: `${standing.message} ${options.successMessage}`,
            action: { label: undo.label, action: () => {
              undo.action();
              if (shown.current === null || shown.current === both) show(standing);
            } } };
          errorUnder.current.set(both, standing);
          show(both);
          noticeTimer.current = setTimeout(() => { if (shown.current === both) show(standing); }, NOTICE_MS);
        }
        phaseTimer.current = setTimeout(() => setPhase("idle"), duration);
        return { ok: true, value };
      } catch (error) {
        if (options.stale?.()) { setPhase("idle"); return { ok: false, error }; }
        const failureMessage = typeof options.failureMessage === "function"
          ? options.failureMessage(error)
          : options.failureMessage ?? DEFAULT_FAILURE;
        setPhase("failed");
        show({ tone: "error", message: failureMessage });
        // The control returns to idle, while the only explanation stays until dismissed.
        phaseTimer.current = setTimeout(() => setPhase("idle"), NOTICE_MS);
        return { ok: false, error };
      } finally {
        activeRun.current = null;
      }
    })();
    activeRun.current = execution;
    return execution;
  }, [show]);

  const phaseFor = (key: string): ActionFeedbackPhase => (activeKey === key ? phase : "idle");

  return {
    phase,
    notice,
    dismiss,
    notify,
    run,
    phaseFor,
    /** One owner, one write at a time: every keyed control waits while any of them is pending. */
    controlPropsFor: (key: string) => ({ ...feedbackStateProps(phaseFor(key)), disabled: phase === "pending" }),
    controlProps: {
      className: styles.control,
      "data-feedback-state": phase === "idle" ? undefined : phase,
      "aria-busy": phase === "pending" ? true : undefined,
      disabled: phase === "pending",
    },
  } as const;
}

export default function ActionFeedbackToast({ notice, placement = "bottom", onDismiss, action, detail }: {
  notice: ActionFeedbackNotice | null;
  placement?: "top" | "bottom";
  onDismiss: () => void;
  action?: ActionFeedbackNotice["action"];
  detail?: string;
}) {
  if (!notice) return null;
  const visibleAction = action ?? notice.action;
  return (
    <div className={`${styles.host} ${styles[placement]}`}>
      <Toast role={notice.tone === "error" ? "alert" : "status"}
        className={`${styles.notice} ${styles[notice.tone]}`}>
        <span>{notice.message}</span>
        {detail && <span>{detail}</span>}
        {visibleAction && <button type="button" className={styles.action} onClick={() => {
          // Dismissed first, so a notice the action itself raises (a refused Undo) stays on screen.
          onDismiss();
          visibleAction.action();
        }}>{visibleAction.label}</button>}
        <button type="button" className={styles.dismiss} aria-label="Dismiss notification"
          onClick={onDismiss}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </Toast>
    </div>
  );
}
