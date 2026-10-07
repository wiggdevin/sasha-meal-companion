import type { Cue } from "@/components/today/care/sound";

/**
 * The award catalog (owner, 2026-10-07: "awards should spin, bounce off all the walls, glow with
 * sparks everywhere"; triggers and copy from GPT-6 Astra's scene spec §D). Presentation only: which
 * award a person has earned comes from the server (UI-NEEDS SPROUT-CARE, care_accolades), never from
 * the phone. Every trigger is safe for a health app: nothing rewards eating less, going under
 * calories, short sleep or fast loss, and a weight milestone exists only for an account whose goal is
 * loss and who opted in. The triggers here describe the contract; the server enforces every gate.
 */

export type Material = "stone" | "earth" | "grass" | "wood" | "metal" | "neon";
export type Scene = "token" | "flex" | "bat";

export type Award = {
  key: string;
  title: string;
  /** One sentence that observes; never a command. */
  line: string;
  material: Material;
  scene: Scene;
  cue: Cue;
  /** What the server must have seen (for the backend contract and the design gallery). */
  trigger: string;
};

export const MATERIAL_ART: Record<Material, string> = {
  stone: "/pet/awards/award-stone.webp",
  earth: "/pet/awards/award-earth.webp",
  grass: "/pet/awards/award-grass.webp",
  wood: "/pet/awards/award-wood.webp",
  metal: "/pet/awards/award-metal.webp",
  neon: "/pet/awards/award-neon.webp",
};

export const AWARDS: readonly Award[] = [
  { key: "first-meal", title: "First meal", line: "Your first meal is recorded.", material: "stone", scene: "token", cue: "tok",
    trigger: "the first retained meal" },
  { key: "first-complete-day", title: "A whole day", line: "You marked today complete.", material: "earth", scene: "token", cue: "chime",
    trigger: "the first explicit day-complete mark" },
  { key: "full-week", title: "Every day this week", line: "A meal recorded every day this week.", material: "grass", scene: "token", cue: "chime",
    trigger: "a retained meal on all seven dates of a completed local week" },
  { key: "seven-days", title: "Seven days together", line: "A week of days recorded with Sprout.", material: "wood", scene: "bat", cue: "clack",
    trigger: "seven distinct active dates" },
  { key: "thirty-days", title: "Thirty days together", line: "A month of days recorded with Sprout.", material: "wood", scene: "token", cue: "clack",
    trigger: "thirty distinct active dates" },
  { key: "goal-5", title: "Your goal, five times", line: "Your chosen goal, five times.", material: "stone", scene: "token", cue: "tok",
    trigger: "five dates that reached a protein or water goal (never a calorie goal)" },
  { key: "goal-20", title: "Your goal, twenty times", line: "Your chosen goal, twenty times.", material: "metal", scene: "token", cue: "shink",
    trigger: "twenty dates that reached a protein or water goal (never a calorie goal)" },
  { key: "protein-5", title: "Protein, five days", line: "Five protein-goal days recorded.", material: "grass", scene: "token", cue: "chime",
    trigger: "five known dates that reached the protein target" },
  { key: "water-5", title: "Water, five days", line: "Five water-goal days recorded.", material: "neon", scene: "token", cue: "plink",
    trigger: "five dates that reached the water goal" },
  { key: "workout-pair", title: "Two in a row", line: "Two workout days in a row.", material: "metal", scene: "flex", cue: "shink",
    trigger: "recorded workouts on two consecutive dates" },
  { key: "workout-10", title: "Ten workouts", line: "Ten workout days recorded.", material: "metal", scene: "token", cue: "shink",
    trigger: "ten dates with a recorded workout" },
  { key: "first-note", title: "A note kept", line: "A note kept for later.", material: "wood", scene: "token", cue: "clack",
    trigger: "the first saved note" },
  { key: "first-recipe", title: "First recipe", line: "Your first recipe is planned.", material: "wood", scene: "token", cue: "clack",
    trigger: "the first accepted recipe selection" },
  { key: "welcome-back", title: "Welcome back", line: "Good to see you.", material: "neon", scene: "token", cue: "chime",
    trigger: "activity after seven inactive dates, at most once a month" },
  { key: "weight-milestone", title: "Your milestone", line: "Your chosen weight milestone.", material: "earth", scene: "token", cue: "chime",
    trigger: "opt-in AND a loss goal: the trend stays 5 lb below the opt-in baseline across seven days with 3+ weigh-ins" },
];

/** Glow and spark colours by material, as design tokens (Island and nutrition tokens). */
export const MATERIAL_TONE: Record<Material, string> = {
  stone: "var(--color-on-olive)",
  earth: "var(--color-gauge-calories-end)",
  grass: "var(--color-gauge-carbs-end)",
  wood: "var(--color-gauge-fat-end)",
  metal: "var(--color-gauge-water-end)",
  neon: "var(--color-gauge-protein-end)",
};

export const awardByKey = (key: string): Award | undefined => AWARDS.find((award) => award.key === key);
