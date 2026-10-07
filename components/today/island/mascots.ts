import type { PetMood } from "@/lib/today/pet-mood";

/**
 * The companions a person can choose (owner, 2026-10-07: "Choose a mascot"; "I like the mascots,
 * they're awesome"). Sprout is the default; the others share its felt look and its eight poses. The
 * choice is stored as `user_settings.mascot` (free text, default "sprout") once the care backend
 * lands; until then the picker plays on samples. The names are working names.
 */
export type MascotPose = PetMood | "wave" | "listening" | "thinking" | "pointing";
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
