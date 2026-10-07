/**
 * The coach turn's clocks (lib/server/coach-turn.ts): every read, model call and save is raced
 * against a deadline counted from the request's arrival, and work that overruns is left to finish
 * unobserved rather than holding the phone past its own 40 s budget.
 */

import { after } from "next/server";
import type { TurnStep } from "@/lib/coach/turn";
import { ASSISTANT_NAME } from "@/lib/brand";

/**
 * The turn's own backstop. Since 2026-09-14 generateStructured also bounds each individual
 * provider attempt with a real AbortSignal (PER_CALL_TIMEOUT_MS), which CANCELS a stalled
 * request rather than abandoning it; this race remains the outer guarantee that the turn ends
 * on time even if a transport ignores the signal. Production smoke
 * 2026-09-13: an off-plan request stuck the UI on "Thinking" for 3+ minutes with no /api/coach
 * response, ever. This races the in-flight call against that budget in real wall-clock time —
 * never the injected `now`, which callers hold fixed in tests — so a turn always ends with the
 * same "took too long" abort a normal wall-clock check would produce, instead of hanging until the
 * provider eventually answers or errors.
 */
export function withWallClock(start: () => Promise<TurnStep>, budgetMs: number): Promise<TurnStep> {
  // A spent budget starts no model call at all: a request nobody will wait for still costs money
  // and holds the function open.
  if (budgetMs <= 0) return Promise.resolve({ kind: "abort", reason: "wall_clock" });
  const promise = start();
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<TurnStep>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "abort", reason: "wall_clock" }), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A read started now and judged later: its failure is held, not thrown, until it is applied. */
export function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then((value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }));
}

export function unwrap<T>(settled: Settled<T>): T {
  if (!settled.ok) throw settled.error;
  return settled.value;
}

export const LATE = Symbol("late");
/** What the ai_calls link may add past the reply deadline; the rest of the reserve is the save. */
export const AI_CALL_LOOKUP_GRACE_MS = 500;

/**
 * The work, or LATE once `deadlineAt` (epoch ms) passes. A deadline already past starts no work at
 * all; callers that own an AbortController can cancel in-flight work on LATE. Other overruns
 * finish unobserved (review r2: the ports stop before writing once the turn's signal is aborted).
 */
export async function beforeDeadline<T>(
  start: () => Promise<T>, deadlineAt: number,
): Promise<T | typeof LATE> {
  const budgetMs = deadlineAt - Date.now();
  if (budgetMs <= 0) return LATE;
  const work = start();
  void work.catch(() => undefined);
  let timer!: ReturnType<typeof setTimeout>;
  const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), budgetMs); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export const TIMEOUT_MESSAGE = `${ASSISTANT_NAME} did not answer in time. Try again.`;

/**
 * Work that must not hold the response: scheduled with `after()` inside a request, and simply
 * started outside one (tests, scripts), where `after()` throws.
 */
export function afterResponse(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
