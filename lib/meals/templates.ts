/**
 * Occasion templates (Phase 17 O1, D4): the parts a plate needs for its occasion.
 *
 *   breakfast  anchor + (starch | fruit)               optional: the other of starch/fruit, veg, fat,
 *                                                      a second protein
 *   main       anchor + starch + veg (when Eats has a  optional: fat. Fruit is never on a main
 *              vegetable that pairs with the anchor)   plate, nor a second protein: a savoury
 *                                                      main grows a side instead (as the coach).
 *   snack      anchor, or fruit + fat                  optional: fruit or starch, fat
 *
 * Lunch, dinner and an overnight ("other") meal use the main template. A meal with no known time
 * follows its anchor: a family usual at breakfast (eggs, yogurt) gets the breakfast plate.
 * A legume anchor (lentils, dal, beans) carries its own starch, so the starch a plate needs is
 * optional beside it ("Lentils with spinach" is a whole plate; "with rice" is still allowed).
 *
 * Pure. No I/O.
 */

import type { Part } from "@/lib/coach/portion-bands";
import type { Occasion } from "@/lib/meals/occasion";

export type TemplateKey = "breakfast" | "main" | "snack";

/** One requirement: any one of these parts satisfies it. */
export type Requirement = readonly Part[];

export type Template = {
  key: TemplateKey;
  required: readonly Requirement[];
  optional: readonly Part[];
  /**
   * A main prefers a vegetable whenever the account has one that pairs with the anchor. A
   * preference, not a requirement: a tight protein target may leave it off (lib/meals/plate.ts).
   */
  vegIfAvailable: boolean;
  /** Parts a plate may never carry in this template. */
  never: readonly Part[];
};

export const TEMPLATES: Readonly<Record<TemplateKey, Template>> = {
  breakfast: { key: "breakfast", required: [["anchor"], ["starch", "fruit"]],
    optional: ["starch", "fruit", "veg", "fat", "protein"], vegIfAvailable: false, never: [] },
  main: { key: "main", required: [["anchor"], ["starch"]],
    optional: ["veg", "fat"], vegIfAvailable: true, never: ["fruit", "protein"] },
  snack: { key: "snack", required: [["anchor"]],
    optional: ["fruit", "starch", "fat"], vegIfAvailable: false, never: ["veg", "protein"] },
};

/** The snack's second form: no anchor, a fruit with a fat (an apple with peanut butter). */
export const ANCHORLESS_SNACK: Template = {
  key: "snack", required: [["fruit"], ["fat"]], optional: ["starch"], vegIfAvailable: false,
  never: ["anchor", "veg", "protein"],
};

/** The template for an occasion; an untimed meal follows its anchor's usual occasions. */
export function templateFor(
  occasion: Occasion, untimed = false, anchorUsual: readonly Occasion[] = [],
): TemplateKey {
  if (occasion === "breakfast") return "breakfast";
  if (occasion === "snack") return "snack";
  if (untimed && anchorUsual.includes("breakfast")) return "breakfast";
  return "main";
}

export type TemplateContext = {
  /** The anchor is itself a starch (a legume), so the plate's carb requirement is optional. */
  anchorCarriesStarch: boolean;
};

/** The requirements a plate's parts leave unmet: empty when the template is satisfied. */
export function unmetRequirements(
  template: Template, parts: readonly Part[], context: TemplateContext,
): Requirement[] {
  const has = (part: Part) => parts.includes(part);
  const unmet: Requirement[] = [];
  for (const requirement of template.required) {
    const carb = requirement.includes("starch") || requirement.includes("fruit");
    if (carb && context.anchorCarriesStarch && has("anchor")) continue;
    if (!requirement.some(has)) unmet.push(requirement);
  }
  if (parts.some((part) => template.never.includes(part))) unmet.push([]);
  return unmet;
}

const PART_WORD: Record<Part, string> = {
  anchor: "protein", protein: "protein", starch: "starch", veg: "vegetable", fruit: "fruit", fat: "fat",
};

/** "No breakfast starch or fruit fits yet — try another food"; no occasion word for an overnight or
 *  untimed slot. Favorites boost a food and never gate one, so the copy never asks the person to
 *  add a food to a list before it can be used (owner direction, onb3). */
export function shortageReason(occasion: Occasion, missing: readonly Part[],
  foodWorld: "open" | "closed" = "closed"): string {
  const words = [...new Set(missing.map((part) => PART_WORD[part]))];
  const what = words.length ? words.join(" or ") : "food";
  const when = occasion === "other" ? "" : `${occasion} `;
  // "Favored" is the open world's word (D13); a closed account has no such list to point at.
  return `No ${when}${what} fits yet — try another food${foodWorld === "open" ? " or Favor one you like" : ""}`;
}

/** Proteins eaten with a soft base at breakfast: yogurt, cottage cheese, a shake. */
const SWEET_PROTEIN = /\byog(?:h)?urt\b|\bskyr\b|\bquark\b|\bcottage cheese\b|\b(?:whey|casein)\b|\bprotein (?:powder|shake|drink)\b/i;

/** Starches fruit or yogurt sits with at breakfast: porridge, cereal, bread, flatbread; not rice. */
const SWEET_BASE = /\b(?:oat|oats|oatmeal|porridge|muesli|granola|cereal|toast|bread|bagel|pancakes?|waffles?|crepes?|english muffin|roti|chapati|paratha|naan|pita|flatbread|lavash|injera)\b/i;

/**
 * Whole-plate coherence beyond each side's pairing with the anchor (D4): a breakfast plate does
 * not carry fruit and a vegetable together, and fruit, yogurt or a shake sits only with a
 * sweet-base starch ("Eggs with rice and banana" and "Greek yogurt with rice" are refused;
 * "Greek yogurt with oats and berries" is not).
 */
export function coherentWhole(template: TemplateKey, rows: readonly { food: { name: string }; part: Part }[]): boolean {
  if (template !== "breakfast" && template !== "snack") return true;
  const has = (part: Part) => rows.some((row) => row.part === part);
  if (has("fruit") && has("veg")) return false;
  const sweet = has("fruit") || rows.some((row) => SWEET_PROTEIN.test(row.food.name));
  const starches = rows.filter((row) => row.part === "starch");
  return !sweet || starches.every((row) => SWEET_BASE.test(row.food.name));
}
