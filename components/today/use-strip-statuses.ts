"use client";

import { useEffect, useRef, useState } from "react";
import { completionFor, type DayCompletionStatus } from "@/lib/today/calendar";
import { resolveStripDay } from "@/lib/today/resolve-strip-day";
import type { TodayLive } from "@/lib/today/resolve-inputs";
import type { Store } from "@/lib/types";

/** No requestIdleCallback on Safari: a plain macrotask budget stands in for it. */
const CHUNK_BUDGET_MS = 8;

/**
 * Lazy, cached per-day completion status for the calendar strip and its month grid (Sol R2 review:
 * the strip's own 57-day resolve, every one of them a full generated-plate search, used to run
 * synchronously inside a `useMemo` that a fresh `store`/`live` object busted on every Today render —
 * 780-900 ms of blocked main thread per render on a real account). A future day never needs
 * resolving at all: `completionFor` would answer "not due yet" before reading anything, so the
 * caller filters those out before asking this hook for one, and it is never asked to confirm it.
 * Everything from today backward needs the real resolve, so that work runs off the render path, in
 * `dates`' given priority order (the caller orders it — visible days first, then outward), one
 * ~8 ms-budgeted chunk per macrotask via `setTimeout`.
 *
 * The displayed map is never cleared mid-recompute: a day keeps its last known status while a
 * newer run catches up, so nothing flickers to blank. A day this hook has never resolved is simply
 * absent from the map — the caller treats a missing key as neutral, never a synchronous guess. A
 * generation counter cancels a stale run's remaining chunks and its scheduled timer the moment
 * `store`, `live`, `today` or `dates` changes again (by reference — an unchanged render passes the
 * very same `dates` array back, from the caller's own `useMemo`, so this effect does not re-run and
 * nothing is recomputed), or the hook unmounts.
 */
export function useStripStatuses(store: Store, live: TodayLive | undefined, today: string,
  dates: readonly string[]): ReadonlyMap<string, DayCompletionStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, DayCompletionStatus>>(() => new Map());
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    const queue = dates.filter((date) => date <= today);
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function runChunk() {
      if (mine !== generation.current) return; // superseded: a newer run owns the map now
      const start = performance.now();
      const updates: [string, DayCompletionStatus][] = [];
      while (index < queue.length && performance.now() - start < CHUNK_BUDGET_MS) {
        const date = queue[index++];
        updates.push([date, completionFor(resolveStripDay(store, date, live), today)]);
      }
      if (updates.length) {
        setStatuses((previous) => {
          const next = new Map(previous);
          for (const [date, status] of updates) next.set(date, status);
          return next;
        });
      }
      timer = index < queue.length ? setTimeout(runChunk, 0) : null;
    }

    if (queue.length) timer = setTimeout(runChunk, 0);
    return () => {
      generation.current = mine + 1;
      if (timer) clearTimeout(timer);
    };
  }, [store, live, today, dates]);

  return statuses;
}
