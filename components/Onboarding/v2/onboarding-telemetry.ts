"use client";

/**
 * Followups #18 (W15's analytics hook), the shell side: step and question timing for onboarding
 * v2, through `lib/profile/onboarding-events-client.ts`. Only the closed enums travel — a step or
 * question identifier and a duration — never an answer, a chip, a number the person typed or any
 * free text. `pilot_arm_assigned` is not sent: there is no randomisation yet (W15).
 *
 * The v2 beats map onto the enum's steps (no new enum value is invented):
 *   opener → intro · facts, week, pace, day → facts · safety → allergy · foods → foods ·
 *   reward → reward · minor (the friendly stop) → done.
 * Beats that share a step are one continuous step. The open fact question, and the week beat's
 * activity question, are the enum's questions.
 *
 * `finish()` (a save or a skip, before navigating) leaves the current step, enters `done` and
 * awaits the flush. A page hidden or a shell unmounted before that reports `step_abandoned`.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  flushOnboardingEvents, queueOnboardingEvent,
} from "@/lib/profile/onboarding-events-client";
import {
  ONBOARDING_EVENT_QUESTIONS, type OnboardingEventQuestion, type OnboardingEventStep,
} from "@/lib/profile/onboarding-events";

const STEP_FOR_BEAT: Record<string, OnboardingEventStep> = {
  opener: "intro", facts: "facts", week: "facts", pace: "facts", day: "facts",
  safety: "allergy", foods: "foods", reward: "reward", minor: "done",
};

export function stepForBeat(beat: string): OnboardingEventStep | null {
  return STEP_FOR_BEAT[beat] ?? null;
}

/** The enum question on screen: the open fact question, or the week beat's activity question. */
export function questionFor(beat: string, askingField: string | null): OnboardingEventQuestion | null {
  const candidate = beat === "week" ? "activity" : beat === "facts" ? askingField : null;
  return candidate && (ONBOARDING_EVENT_QUESTIONS as readonly string[]).includes(candidate)
    ? candidate as OnboardingEventQuestion : null;
}

type Open<T> = { id: T; since: number } | null;

export function useOnboardingTelemetry(beat: string, askingField: string | null, now: () => number = Date.now) {
  const step = useRef<Open<OnboardingEventStep>>(null);
  const question = useRef<Open<OnboardingEventQuestion>>(null);
  const ended = useRef(false);
  // Read through a ref, so a new clock function never re-runs the effects below.
  const clock = useRef(now);
  useEffect(() => { clock.current = now; }, [now]);

  const leaveQuestion = useCallback(() => {
    if (!question.current) return;
    queueOnboardingEvent({ kind: "question_left", question: question.current.id,
      durationMs: Math.max(0, clock.current() - question.current.since) });
    question.current = null;
  }, []);

  const leaveStep = useCallback((kind: "step_left" | "step_abandoned") => {
    leaveQuestion();
    if (!step.current) return;
    queueOnboardingEvent({ kind, step: step.current.id, durationMs: Math.max(0, clock.current() - step.current.since) });
    step.current = null;
  }, [leaveQuestion]);

  // Declared first so a remount (React's development double mount) opens the flow again before
  // the step effect below runs.
  useEffect(() => {
    ended.current = false;
    const abandon = () => {
      if (ended.current) return;
      ended.current = true;
      leaveStep("step_abandoned");
      void flushOnboardingEvents();
    };
    window.addEventListener("pagehide", abandon);
    return () => { window.removeEventListener("pagehide", abandon); abandon(); };
  }, [leaveStep]);

  const nextStep = stepForBeat(beat);
  const nextQuestion = questionFor(beat, askingField);
  useEffect(() => {
    if (ended.current) return;
    if (step.current?.id !== nextStep) {
      leaveStep("step_left");
      if (nextStep) {
        queueOnboardingEvent({ kind: "step_entered", step: nextStep });
        step.current = { id: nextStep, since: clock.current() };
      }
      void flushOnboardingEvents();
    }
    if (question.current?.id !== nextQuestion) {
      leaveQuestion();
      if (nextQuestion) {
        queueOnboardingEvent({ kind: "question_entered", question: nextQuestion });
        question.current = { id: nextQuestion, since: clock.current() };
      }
    }
  }, [nextStep, nextQuestion, leaveStep, leaveQuestion]);

  /** The flow finished (saved or skipped): leave the step, enter `done`, and send it all. */
  const finish = useCallback(async () => {
    if (!ended.current) {
      ended.current = true;
      leaveStep("step_left");
      queueOnboardingEvent({ kind: "step_entered", step: "done" });
    }
    await flushOnboardingEvents();
  }, [leaveStep]);

  return useMemo(() => ({ finish }), [finish]);
}
