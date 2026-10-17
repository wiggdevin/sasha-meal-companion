import type { PetMood } from "@/lib/today/pet-mood";

/**
 * The companions a person can choose (owner, 2026-10-07: "Choose a mascot"; "I like the mascots,
 * they're awesome"). Sprout is the default; the others share its felt look and its eight poses. The
 * choice is stored as `user_settings.mascot` (free text, default "sprout") once the care backend
 * lands; until then the picker plays on samples. The names are working names.
 */
export type MascotPose = PetMood | "droopy" | "wave" | "listening" | "thinking" | "pointing";
export type MascotKey = "sprout" | "blueberry" | "mushroom" | "peapod";

export type Mascot = {
  key: MascotKey;
  name: string;
  /** One line that describes it; never about food, weight or what to do. */
  line: string;
  /** Hero-size art (768 px square), one shared frame per mascot so a pose change never moves it. */
  art: Record<MascotPose, string>;
};

const POSES: MascotPose[] = ["content", "joyful", "sleepy", "droopy", "wave", "listening", "thinking", "pointing"];
const artFor = (folder: string) =>
  Object.fromEntries(POSES.map((pose) => [pose, `/pet/mascots/${folder}/${pose}.webp`])) as Record<MascotPose, string>;

export const MASCOTS: Record<MascotKey, Mascot> = {
  sprout: { key: "sprout", name: "Sprout", line: "A little pear with a leafy sprout.",
    art: Object.fromEntries(POSES.map((pose) => [pose, `/pet/hero/sprout-${pose}.webp`])) as Record<MascotPose, string> },
  blueberry: { key: "blueberry", name: "Blu", line: "A round blueberry with rosy cheeks.", art: artFor("blueberry") },
  mushroom: { key: "mushroom", name: "Button", line: "A cosy mushroom under a speckled cap.", art: artFor("mushroom") },
  peapod: { key: "peapod", name: "Pod", line: "Three peas, one pod, one mood.", art: artFor("peapod") },
};
export const MASCOT_KEYS = Object.keys(MASCOTS) as MascotKey[];

/** A stored value that is not a known mascot falls back to Sprout (the column is free text). */
export const mascotOf = (value: string | null | undefined): Mascot =>
  MASCOTS[(MASCOT_KEYS as string[]).includes(value ?? "") ? (value as MascotKey) : "sprout"];

/** Poses drawn for the pond, water, care and award scenes, one set per companion. */
export const SCENE_POSES = ["annoyed", "cast", "catch", "dance-1", "dance-2", "doze", "fishing", "lookback",
  "rockthrow-release", "rockthrow-windup", "stick-1", "stick-2", "sulk", "swim", "tummy-round", "tummy-suck",
  "workout-flex", "workout-lift", "massage-1", "massage-2", "bucket-hold", "bucket-pour",
  "award-workout-flex", "award-workout-lift"] as const;
export type ScenePose = (typeof SCENE_POSES)[number];

/** Sprout's scene art keeps its first paths; every other companion's lives under its own folder. */
function sproutScene(pose: ScenePose): string {
  if (pose.startsWith("massage-")) return `/pet/care/${pose}.webp`;
  if (pose.startsWith("bucket-")) return `/pet/water/sprout-${pose}.webp`;
  if (pose.startsWith("award-")) return `/pet/awards/sprout-${pose.slice("award-".length)}.webp`;
  return `/pet/scene/sprout-${pose}.webp`;
}

/** The chosen companion's art for one scene pose, so every scene draws the companion itself. */
export const sceneArt = (mascot: MascotKey, pose: ScenePose): string =>
  mascot === "sprout" ? sproutScene(pose) : `/pet/mascots/${mascot}/scene/${pose}.webp`;

/** Copy written with Sprout's name, said with the chosen companion's ("Sprout's pond" → "Blu's pond"). */
export const named = (text: string, mascot: MascotKey): string =>
  mascot === "sprout" ? text : text.replace(/\bSprout\b/g, MASCOTS[mascot].name);
