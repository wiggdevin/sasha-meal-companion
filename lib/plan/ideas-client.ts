"use client";
/**
 * The phone half of a Plan-sheet chip: one POST /api/plan/ideas, timed per chip into
 * `client_timings` (path `plan-chip:<chip>`): `sent` from the tap to the answer, the server's own
 * build time as `server`, and `card-visible` closed by the sheet once the cards render.
 */
import { AccountChanged, accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import type { PlanChip, PlanIdeasRequest, PlanIdeasResponse } from "@/lib/plan/chips";
import { beginRun, mark, markMs, measure, type TimingPath, type TimingRun } from "@/lib/timing";

export class PlanIdeasError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export const chipPath = (chip: PlanChip): TimingPath => `plan-chip:${chip}`;

/** A chip's open timing run; `done()` closes it once the cards are on screen. */
export type ChipRun = { run: TimingRun; done: (serverMs?: number) => void };

export function startChipRun(chip: PlanChip): ChipRun {
  const path = chipPath(chip);
  const run = beginRun(path);
  mark(path, "sent", run);
  return {
    run,
    done: (serverMs) => {
      if (serverMs !== undefined) markMs(path, "server", serverMs, run);
      measure(path, run);
    },
  };
}

export async function requestPlanIdeas(h: AccountHandle, body: PlanIdeasRequest,
  timing?: ChipRun): Promise<PlanIdeasResponse> {
  let res: Response;
  try {
    res = await accountFetch(h, "/api/plan/ideas", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }, { budget: "ideas" });
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    timing?.done();
    throw new PlanIdeasError("That took too long. Try again.", true);
  }
  const json = await accountJson<PlanIdeasResponse & { message?: string }>(h, res).catch((error: unknown) => {
    // The account changed while the answer was read: the sheet closes, never shows a failure.
    if (error instanceof AccountChanged) throw error;
    return null;
  });
  if (!res.ok || !json || !Array.isArray(json.cards)) {
    timing?.done();
    throw new PlanIdeasError(json?.message ?? "Couldn’t find meal ideas. Try again.",
      res.status === 0 || res.status >= 500 || res.status === 429);
  }
  if (timing) mark(chipPath(body.chip), "card-visible", timing.run);
  return json;
}
