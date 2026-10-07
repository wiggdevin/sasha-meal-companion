import { after } from "next/server";

/**
 * Schedules best-effort work (facet warming) for after the response is sent. Next's `after()`
 * throws outside a request scope (route tests, scripts); a deferred warm must never turn a
 * successful commit into a 500, so that case logs once and skips — the cache fills on the next
 * in-scope request or through scripts/warm-facets.ts.
 */
export function afterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch (error) {
    console.warn("[after-response] no request scope; skipping deferred task", {
      error: error instanceof Error ? error.message.slice(0, 120) : "unknown error",
    });
  }
}
