/**
 * Sprout's sulk at the pond (rules from GPT-6 Astra's spec §F). Pure: the scene passes the time and
 * reads back a pose and a line. The words observe; they never blame and never tell anyone to eat.
 *
 * - Sprout sulks only when poked, never because the day is behind on food or water (owner decision
 *   OD19, docs/decisions/2026-10-12-owner-decisions.md, replacing the 2026-10-07 "day" sulk).
 * - Pokes are counted over 8 s. Not sulking, the first two are greetings; the third starts a short
 *   poke sulk (6 s). Poking a sulk makes Sprout look back with tears, then turn away again.
 * - A fourth poke inside the window makes Sprout annoyed for 3 s; more pokes do not extend it.
 */

export type SulkMode = "none" | "poke";
export type Pose = "fishing" | "sulk" | "lookback" | "annoyed";
export type Reaction = "greet" | "lookBack" | "annoyed" | "ignored";

export type SulkState = {
  /** A poke sulk's end, ms; 0 when none. */
  pokeUntil: number;
  /** The look-back over the shoulder, ms; 0 when none. */
  lookUntil: number;
  /** Annoyed until, ms; 0 when none. */
  annoyedUntil: number;
  /** Times of recent pokes, ms, newest last. */
  pokes: number[];
};

export const POKE_WINDOW_MS = 8000;
export const POKE_SULK_MS = 6000;
export const LOOK_BACK_MS = 1850;
export const ANNOYED_MS = 3000;

export const SULK_LINES = {
  poke: "Sprout takes a moment.",
  annoyed: "Sprout wants a little space.",
} as const;

export const initialSulk = (): SulkState => ({ pokeUntil: 0, lookUntil: 0, annoyedUntil: 0, pokes: [] });

export function sulkMode(state: SulkState, now: number): SulkMode {
  return now < state.pokeUntil ? "poke" : "none";
}

/** A poke on Sprout. Returns the new state and what Sprout does about it. */
export function poke(state: SulkState, now: number): { state: SulkState; reaction: Reaction } {
  if (now < state.annoyedUntil) return { state, reaction: "ignored" };
  const pokes = [...state.pokes.filter((t) => now - t < POKE_WINDOW_MS), now];
  const mode = sulkMode(state, now);
  if (pokes.length >= 4) {
    return { state: { ...state, pokes: [], lookUntil: 0, annoyedUntil: now + ANNOYED_MS }, reaction: "annoyed" };
  }
  if (mode !== "none") {
    return { state: { ...state, pokes, lookUntil: now + LOOK_BACK_MS }, reaction: "lookBack" };
  }
  if (pokes.length === 3) {
    return { state: { ...state, pokes, pokeUntil: now + POKE_SULK_MS, lookUntil: now + LOOK_BACK_MS }, reaction: "lookBack" };
  }
  return { state: { ...state, pokes }, reaction: "greet" };
}

/** What Sprout is doing now. `fishing` covers every calm pose (the scene picks cast or catch). */
export function pose(state: SulkState, now: number): Pose {
  if (now < state.annoyedUntil) return "annoyed";
  if (sulkMode(state, now) === "none") return "fishing";
  return now < state.lookUntil ? "lookback" : "sulk";
}

/** The line under the scene for this moment, or null to keep the pet's own mood line. */
export function sulkLine(state: SulkState, now: number): string | null {
  if (now < state.annoyedUntil) return SULK_LINES.annoyed;
  return sulkMode(state, now) === "poke" ? SULK_LINES.poke : null;
}

/** The next moment the pose can change on its own (a timer to wake for), or null. */
export function nextChange(state: SulkState, now: number): number | null {
  const times = [state.pokeUntil, state.lookUntil, state.annoyedUntil].filter((t) => t > now);
  return times.length ? Math.min(...times) : null;
}
