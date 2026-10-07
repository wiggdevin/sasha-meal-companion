/**
 * After the Plan panel logs a plate, a menu pick or "I had …" under a slot, the slot on the day the
 * log was FILED becomes an empty "counted in your log" meal ticked eaten, so the log entry is the one
 * record and nothing counts twice (app/page.tsx `slotLogged`).
 *
 * Audit b4b #2: the filed day, not the day on screen; nothing once the account has changed; each
 * write gets one retry; and a failure never tells the user to tick the planned meal eaten — that
 * would count the plan and the log. If the eaten mark cannot be saved, the empty meal stays: it holds
 * no food, so even a later tick cannot count anything twice (rolling the plan back would bring the
 * double count back within one tap). The failure says so and offers the same writes again.
 */
import { EATEN_LOGGED_NAME, isLoggedShell } from "@/lib/plan/eaten-estimate";
import type { SlotOverride } from "@/lib/types";

export type CountLogOutcome =
  /** The slot now reads eaten through the log. */
  | "counted"
  /** The slot already reads eaten through a log: nothing to do. */
  | "already-eaten"
  /** The account changed: nothing was written, or nothing more was. */
  | "stale"
  /** The empty meal did not save: the plan is still on the card. */
  | "plan-kept"
  /** The empty meal saved but its eaten mark did not. */
  | "eaten-unsaved";

export const COUNT_LOG_FAILURE =
  "Logged, but the meal card did not update. Don’t tick it eaten: the log already counts it.";

export type CountLogSlot = {
  eaten: boolean;
  /** The slot's override before the log (its time and added flag carry over). */
  before?: SlotOverride;
  /** The planned meal's id on the filed day, so the card can still say what it was. */
  baseMealId: string | null;
};

export type CountLogWrites = {
  /** Whether the account the log was made as is still the bound one. */
  isCurrent: () => boolean;
  saveOverride: (override: SlotOverride) => Promise<unknown>;
  saveEaten: (at: string) => Promise<unknown>;
};

/** The empty meal that stands in for the plan once the log counts it. */
export function loggedShell(slot: CountLogSlot): SlotOverride {
  const { before } = slot;
  return { baseMealId: slot.baseMealId ?? before?.baseMealId ?? null, title: EATEN_LOGGED_NAME,
    components: [], ...(before?.time ? { time: before.time } : {}), ...(before?.added ? { added: true } : {}) };
}

/** One write, tried twice, as long as the account it started as is still bound. */
async function twice(writes: CountLogWrites, run: () => Promise<unknown>): Promise<"ok" | "failed" | "stale"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!writes.isCurrent()) return "stale";
    try { await run(); return "ok"; } catch { /* one retry */ }
  }
  return writes.isCurrent() ? "failed" : "stale";
}

export async function countLogOnce(
  slot: CountLogSlot, writes: CountLogWrites, now: () => string = () => new Date().toISOString(),
): Promise<CountLogOutcome> {
  // Already ticked: the log must still become the only record (2026-10-04 re-audit, MAJOR 2), so
  // the empty meal replaces whatever the card held, recipe snapshot included. Only a card that is
  // already that empty meal needs nothing.
  if (slot.eaten && isLoggedShell(slot.before)) return "already-eaten";
  const shell = await twice(writes, () => writes.saveOverride(loggedShell(slot)));
  if (shell !== "ok") return shell === "stale" ? "stale" : "plan-kept";
  if (slot.eaten) return "counted";
  const at = now();
  const eaten = await twice(writes, () => writes.saveEaten(at));
  return eaten === "ok" ? "counted" : eaten === "stale" ? "stale" : "eaten-unsaved";
}
