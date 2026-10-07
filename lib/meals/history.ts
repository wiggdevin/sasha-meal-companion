/**
 * The account's own history as occasion evidence (Phase 17 O2, D1 and D3).
 *
 * A food counts for an occasion only after it was logged at that occasion on 3 distinct days in the
 * last 90 (one accidental breakfast log changes nothing). Each counted day weighs by its age, half
 * as much every 30 days, and the score is
 *
 *   0.75 + 0.25 × (1 − e^(−weight / 3))       three days this week ≈ 0.91; daily for a month → 1.0
 *
 * so history that qualifies always makes a food a usual choice at that occasion, and more recent,
 * more frequent history makes it more so. History supports an anchor at an occasion; it never says
 * which side goes with it (D6) — pairing stays curated (lib/meals/affinity.ts).
 *
 * Input is already reduced to (food, occasion, local date) triples by the server read
 * (lib/server/history-affinity.ts); nothing here sees a note, a time or an amount, and the output
 * holds scores only.
 *
 * Pure. No I/O.
 */

import type { Occasion } from "@/lib/meals/occasion";

export const HISTORY_WINDOW_DAYS = 90;
export const HISTORY_MIN_DAYS = 3;
export const HISTORY_HALF_LIFE_DAYS = 30;

export type HistoryLog = { food: string; occasion: Occasion; localDate: string };

export type HistoryScores = Record<string, Partial<Record<Occasion, number>>>;

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : Number.NaN;
}

/** The first local date inside the window that ends on `today` (both inclusive). */
export function historyWindowStart(today: string): string {
  return new Date((dayNumber(today) - (HISTORY_WINDOW_DAYS - 1)) * DAY_MS).toISOString().slice(0, 10);
}

/** Four decimals: the same number on every runtime, so phone and server agree byte for byte. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Per food, per occasion: the history score, only where the food qualifies. */
export function historyScores(logs: readonly HistoryLog[], today: string): HistoryScores {
  const end = dayNumber(today);
  if (!Number.isFinite(end)) return {};
  const days = new Map<string, Set<number>>();
  for (const log of logs) {
    const day = dayNumber(log.localDate);
    if (!Number.isFinite(day) || day > end || day <= end - HISTORY_WINDOW_DAYS) continue;
    const key = `${log.food}\u0000${log.occasion}`;
    const seen = days.get(key) ?? new Set<number>();
    seen.add(day);
    days.set(key, seen);
  }
  const out: HistoryScores = {};
  for (const key of [...days.keys()].sort()) {
    const seen = days.get(key) as Set<number>;
    if (seen.size < HISTORY_MIN_DAYS) continue;
    const [food, occasion] = key.split("\u0000") as [string, Occasion];
    const weight = [...seen].reduce((sum, day) => sum + 0.5 ** ((end - day) / HISTORY_HALF_LIFE_DAYS), 0);
    (out[food] ??= {})[occasion] = round(0.75 + 0.25 * (1 - Math.exp(-weight / 3)));
  }
  return out;
}
