/**
 * Sprout, the pet in the Day card's glass well (owner, 2026-10-06: "the better one takes care of
 * themselves, the better their pet will do"). v1 is presentational: its mood is read from the day the
 * phone already holds and nothing is stored. Upgrades and a remembered streak need a server contract
 * (the backend lane's).
 *
 * Rules (GPT-6 Sol review, 2026-10-06):
 * - Only what is known counts: a target of 0 and a missing water reading are left out, never scored.
 * - Today is judged against where the day should be by now, with a grace window after waking. A past
 *   day is judged whole; a future day is not judged.
 * - A partly measured day (a recipe serving of unknown size) is never called low, and its totals,
 *   being lower bounds, count only once they already keep pace.
 * - A day that has reached its calories is never called low.
 * - The words observe; they never shame and never tell anyone to eat.
 *
 * Pure: the hour and the day's place in time are passed in, so a test can hold the clock.
 */
import type { Macros } from "@/lib/types";

export type PetMood = "content" | "joyful" | "sleepy" | "droopy";
export type PetWhen = "today" | "past" | "future";

export type PetDay = {
  targets: Macros;
  consumed: Macros;
  water?: { cups: number; goal: number };
  /** A partly measured recipe serving in the day: the totals are lower bounds. */
  partial?: boolean;
};

export type PetState = {
  mood: PetMood;
  /** 0–1: how the day is going so far; null when nothing can be judged (a future day, no targets). */
  vitality: number | null;
  /** One plain sentence about the pet, for the stage and for a screen reader. */
  line: string;
};

export const PET_NAME = "Sprout";

/** Nothing is expected before 09:00 (breakfast is the user's own time); the whole day by 20:00. */
const PACE_START = 9;
const PACE_END = 20;
/** Before this hour the day is too young to call low. */
const LOW_FROM = 14;
const NIGHT_FROM = 21;
const NIGHT_UNTIL = 6;

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));

/** How much of the day's targets should be in by this hour (0 in the morning, 1 by evening). */
export function expectedShare(hour: number): number {
  return clamp((hour - PACE_START) / (PACE_END - PACE_START));
}

type Part = { score: number; weight: number };

/**
 * One known measure against where it should be by now; unknown measures are left out. A lower bound
 * counts only once it already keeps pace: the true score is then 1, while a short one could be anything.
 */
function part(value: number, target: number, expected: number, weight: number, lowerBound = false): Part | null {
  if (!(target > 0)) return null;
  if (expected < 0.1) return { score: 1, weight };
  const score = clamp(value / target / expected);
  return lowerBound && score < 1 ? null : { score, weight };
}

export function petState(day: PetDay, hour: number, when: PetWhen = "today"): PetState {
  if (when === "future") return { mood: "content", vitality: null, line: `${PET_NAME} is waiting for this day.` };

  const expected = when === "past" ? 1 : expectedShare(hour);
  const kcalShare = day.targets.kcal > 0 ? day.consumed.kcal / day.targets.kcal : 0;
  const reached = kcalShare >= 1;
  const over = kcalShare > 1.15;
  const fuel = part(day.consumed.kcal, day.targets.kcal, expected, 0.4, day.partial);
  const parts = [
    fuel && over ? { ...fuel, score: 0.6 } : fuel,
    part(day.consumed.protein, day.targets.protein, expected, 0.35, day.partial),
    day.water ? part(day.water.cups, day.water.goal, expected, 0.25) : null,
  ].filter((value): value is Part => value !== null);
  if (parts.length === 0) return { mood: "content", vitality: null, line: `${PET_NAME} is here with you.` };

  const weight = parts.reduce((sum, { weight: w }) => sum + w, 0);
  const vitality = Math.round((parts.reduce((sum, { score, weight: w }) => sum + score * w, 0) / weight) * 100) / 100;

  if (when === "today" && (hour >= NIGHT_FROM || hour < NIGHT_UNTIL)) {
    return { mood: "sleepy", vitality, line: `${PET_NAME} is asleep. Rest well.` };
  }
  const past = when === "past";
  if (vitality >= 0.85 && !over) {
    return { mood: "joyful", vitality, line: past ? "A well cared-for day." : `${PET_NAME} is thriving today.` };
  }
  // A young day, an unmeasured serving or a day that has reached its calories is never called low.
  const mayBeLow = !day.partial && !reached && (past || hour >= LOW_FROM);
  if (vitality >= 0.5 || !mayBeLow) {
    return { mood: "content", vitality, line: past ? "A steady day." : `${PET_NAME} is doing fine.` };
  }
  return { mood: "droopy", vitality, line: past ? "A quieter day for Sprout." : `${PET_NAME} is feeling a little low.` };
}

/** The image for each mood (public/pet, recorded in docs/design/meal-card-image-sources.md). */
export const PET_ART: Record<PetMood, string> = {
  content: "/pet/sprout-content.webp",
  joyful: "/pet/sprout-joyful.webp",
  sleepy: "/pet/sprout-sleepy.webp",
  droopy: "/pet/sprout-droopy.webp",
};
