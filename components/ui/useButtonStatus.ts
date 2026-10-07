"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonStatus } from "@/components/ui/Button";
import { confirmHaptic } from "@/lib/haptics";

/** How long a confirmation and an error hold before the button returns (DESIGN.md §Buttons). */
export const CONFIRM_MS = 1_600;
export const ERROR_MS = 2_400;

export type ButtonRunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A local write confirmed by its own button, for a control with no `useActionFeedback` owner (a
 * Settings field, a weigh-in). `run` marks the button pending, then success (tick, verb, a short
 * haptic) or error, and returns it to rest. A second press while pending is ignored.
 */
export function useButtonStatus() {
  const [status, setStatus] = useState<ButtonStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const settle = useCallback((next: ButtonStatus, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    setStatus(next);
    timer.current = setTimeout(() => setStatus("idle"), ms);
  }, []);

  const run = useCallback(async function run<T>(operation: () => Promise<T>): Promise<ButtonRunResult<T>> {
    if (busy.current) return { ok: false, error: new Error("Already running.") };
    busy.current = true;
    if (timer.current) clearTimeout(timer.current);
    setStatus("pending");
    try {
      const value = await operation();
      confirmHaptic();
      settle("success", CONFIRM_MS);
      return { ok: true, value };
    } catch (error) {
      settle("error", ERROR_MS);
      return { ok: false, error };
    } finally {
      busy.current = false;
    }
  }, [settle]);

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus("idle");
  }, []);

  return { status, run, reset } as const;
}
