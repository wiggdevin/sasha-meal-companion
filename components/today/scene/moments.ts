/**
 * Sprout's moments at the pond (owner, 2026-10-07: "throwing rocks, taking swims, dancing; sometimes he
 * works out with a little white headband and a couple of dumbbells; sometimes he's a little fat or
 * trying to suck his stomach in", and earlier "sitting with a little stick, spinning"). Little scenes
 * Sprout plays on its own now and then while it fishes and the day is fine. Pure data: each is a
 * sequence of poses with how long each holds, and a line that observes. None is ever tied to what the
 * person ate, weighs or did. The tummy is never in the automatic rotation (which only runs while the
 * day is fine, so it would track intake): it plays only when the person asks for it, by double-tapping
 * Sprout.
 */

export type MomentPose = "rockthrow-windup" | "rockthrow-release" | "dance-1" | "dance-2" | "workout-lift" | "workout-flex"
  | "tummy-round" | "tummy-suck" | "stick-1" | "stick-2";
export type MomentKey = "pebble" | "dance" | "workout" | "tummy" | "swim" | "doodle" | "spin";

export type Moment = {
  key: MomentKey;
  /** The poses in order and how long each holds, ms. A swim has none: Sprout is in the water. */
  frames: { pose: MomentPose; ms: number }[];
  /** Swim: how long Sprout is in the lake, ms. */
  swimMs?: number;
  /** Spin: Sprout turns round twice on the spot with a little hop (the pose turns, the rock stays). */
  spin?: boolean;
  line: string;
};

const repeat = <T,>(items: T[], times: number): T[] => Array.from({ length: times }, () => items).flat();

export const MOMENTS: Record<MomentKey, Moment> = {
  pebble: { key: "pebble", line: "Sprout skips a pebble.",
    frames: [{ pose: "rockthrow-windup", ms: 480 }, { pose: "rockthrow-release", ms: 900 }] },
  dance: { key: "dance", line: "Sprout dances on the rock.",
    frames: repeat([{ pose: "dance-1" as const, ms: 380 }, { pose: "dance-2" as const, ms: 380 }], 4) },
  workout: { key: "workout", line: "Sprout squeezes in a quick workout.",
    frames: [{ pose: "workout-lift", ms: 1500 }, { pose: "workout-flex", ms: 1400 }] },
  tummy: { key: "tummy", line: "Sprout pats its tummy.",
    frames: [{ pose: "tummy-round", ms: 1800 }, { pose: "tummy-suck", ms: 1500 }] },
  swim: { key: "swim", line: "Sprout goes for a swim.", frames: [], swimMs: 4600 },
  doodle: { key: "doodle", line: "Sprout doodles in the moss with a twig.",
    frames: repeat([{ pose: "stick-1" as const, ms: 800 }, { pose: "stick-2" as const, ms: 800 }], 3) },
  spin: { key: "spin", line: "Sprout does a little spin on the rock.", frames: [{ pose: "dance-1", ms: 1600 }], spin: true },
};

export const MOMENT_KEYS = Object.keys(MOMENTS) as MomentKey[];
/** The moments Sprout plays on its own. */
export const AUTO_MOMENTS: MomentKey[] = MOMENT_KEYS.filter((key) => key !== "tummy");

/** Time until the next moment: 40–70 s of fishing between them. */
export const nextMomentIn = (random = Math.random) => 40_000 + random() * 30_000;

/** A moment other than the last one, so the same scene never plays twice in a row. */
export function pickMoment(last: MomentKey | null, random = Math.random): MomentKey {
  const pool = AUTO_MOMENTS.filter((key) => key !== last);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** How long a moment runs in total, ms. */
export const momentLength = (moment: Moment): number =>
  moment.swimMs ?? moment.frames.reduce((sum, frame) => sum + frame.ms, 0);

/** The pose at `elapsed` ms into a moment, or null once it is over (or while swimming). */
export function momentPose(moment: Moment, elapsed: number): MomentPose | null {
  let at = 0;
  for (const frame of moment.frames) {
    at += frame.ms;
    if (elapsed < at) return frame.pose;
  }
  return null;
}
