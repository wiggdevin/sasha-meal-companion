"use client";

/**
 * "Still working" — T0 §2.
 *
 * Every capture and coach step now has a deadline, but a bounded wait is still a wait, and a
 * sheet that says nothing for four seconds reads as broken. After two seconds this line says what
 * the app is actually doing. Before two seconds it renders nothing: a fast answer must never
 * flash a note about waiting.
 *
 * No spinner — the words are the signal, and they are announced, because a change the user is not
 * told about has not happened as far as a screen reader is concerned. A hop where the assistant is
 * reading or answering adds the shared thinking orbs (components/ui/Thinking, owner 2026-10-03);
 * a save stays plain words.
 */

import { useEffect, useState } from "react";
import Thinking from "@/components/ui/Thinking";
import type { TimingStep } from "@/lib/timing";

export const WORKING_DELAY_MS = 2000;

/** The step the user is waiting on → what the app is doing, in their own app's plain voice. */
export const WORKING_COPY: Partial<Record<TimingStep, string>> & Record<string, string> = {
  decode: "Reading the code…",
  lookup: "Looking it up…",
  sign: "Getting ready…",
  upload: "Sending it…",
  propose: "Finding matches…",
  model: "Finding matches…",
  ground: "Finding matches…",
  commit: "Saving…",
  "card-visible": "Saving…",
  sent: "Thinking…",
  "first-text": "Thinking…",
  "reply-done": "Thinking…",
  "action-applied": "Applying…",
};

const DEFAULT_COPY = "Working…";

/** The hops where the model is reading or answering: these get the thinking orbs. */
const THINKING_STEPS = new Set<string>([
  "upload", "propose", "model", "ground", "sent", "first-text", "reply-done", "action-applied",
]);

export function isThinkingStep(step: TimingStep | string): boolean {
  return THINKING_STEPS.has(step);
}

/**
 * Where the capture method changes what the app is honestly doing. `upload` was hard-coded to
 * "Reading the label…", so a plate photo and a voice clip both claimed to be reading a label
 * (Grok pass 2, MEDIUM 11). Every other hop means the same thing whatever was captured.
 */
const BY_METHOD: Record<string, Record<string, string>> = {
  upload: {
    label: "Reading the label…",
    photo: "Looking at the plate…",
    voice: "Listening…",
  },
};

export function workingCopy(step: TimingStep | string, method?: string): string {
  const byMethod = method === undefined ? undefined : BY_METHOD[step]?.[method];
  return byMethod ?? WORKING_COPY[step] ?? DEFAULT_COPY;
}

/** The rendered line, separated from the timer so a static render can check the markup. */
export function WorkingLineView({ text, thinking = false }: { text: string; thinking?: boolean }) {
  if (thinking) return <Thinking label={text} />;
  return (
    <p role="status" aria-live="polite" className="text-caption text-muted">
      {text}
    </p>
  );
}

/**
 * The delay itself, as a small controller rather than a piece of component state — because the
 * bug it replaces was exactly component state outliving the hop it described: a second hop of the
 * same name showed its line instantly, having inherited "two seconds have already passed" from
 * the first (Grok 4.6 HIGH 4). A controller is created per activation and starts hidden, so there
 * is nothing left for a later hop to inherit, and the delay is testable without a renderer.
 */
export function workingLineController(
  onChange: (shown: boolean) => void, delayMs: number = WORKING_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  const set = (next: boolean): void => {
    if (next === shown) return;
    shown = next;
    onChange(shown);
  };
  const clear = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  return {
    /** A hop started, or a new one replaced it: hidden now, shown once the delay passes. */
    start(): void {
      clear();
      set(false);
      timer = setTimeout(() => { timer = null; set(true); }, delayMs);
    },
    /** The hop ended. Hidden, and the next one times its own delay from zero. */
    stop(): void {
      clear();
      set(false);
    },
  };
}

export default function WorkingLine({
  active, step, method, delayMs = WORKING_DELAY_MS,
}: { active: boolean; step: TimingStep | string; method?: string; delayMs?: number }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const line = workingLineController(setShown, delayMs);
    if (active) line.start();
    else line.stop();
    // Ending the hop — or changing it — always goes through `stop`, so nothing about this one
    // survives into the next.
    return () => line.stop();
    // The step alone, deliberately. `method` is not in here: a capture whose method is settled
    // late is the same wait the user is already watching, and re-arming the delay would take the line
    // off the screen and start the two seconds again. The words are read at render instead, so
    // they change under a line that never blinks (panel round 10, item 1).
  }, [active, step, delayMs]);

  if (!shown) return null;
  return <WorkingLineView text={workingCopy(step, method)} thinking={isThinkingStep(step)} />;
}
