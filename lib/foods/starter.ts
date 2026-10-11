/** Curated, account-filtered starters from the bundled USDA food list. */
import { starterFacetOutcome } from "./starter-evidence";
import { dbFood } from "@/lib/food-db";
import type { Profile } from "@/lib/constraints-client";
import type { Food, FoodRole, FoodStatus, FoodUnit } from "@/lib/foods";
import { profileFacetOutcome } from "@/lib/policy/profiles/hard-rules";
import { isActiveHardRule, type ProfileInstance } from "@/lib/policy/profiles/types";
import { allergenKey } from "@/lib/policy/allergens";

export type DietStyle = "omnivore" | "pescatarian" | "vegetarian" | "vegan";
export type Starter = { id: string; role: FoodRole; unit: FoodUnit; grams: number; diets: readonly DietStyle[]; allergens?: readonly string[]; categories?: readonly string[]; default?: boolean };
const ALL = ["omnivore", "pescatarian", "vegetarian", "vegan"] as const;
const ANIMAL = ["omnivore", "pescatarian", "vegetarian"] as const;
const SEA = ["omnivore", "pescatarian"] as const;
const LAND = ["omnivore"] as const;
const S = (id: string, role: FoodRole, unit: FoodUnit, grams: number, diets: readonly DietStyle[], extra: Partial<Starter> = {}): Starter => ({ id, role, unit, grams, diets, ...extra });

export const STARTERS: readonly Starter[] = [
  S("chicken-breast-roasted", "protein", "oz", 28.35, LAND, { categories: ["poultry"], default: true }),
  S("turkey-breast-roasted", "protein", "oz", 28.35, LAND, { categories: ["poultry"], default: true }),
  S("ground-beef-90-10-cooked", "protein", "oz", 28.35, LAND, { categories: ["beef"] }),
  S("pork-tenderloin-roasted", "protein", "oz", 28.35, LAND, { categories: ["pork"] }),
  S("salmon-wild-sockeye-cooked", "protein", "oz", 28.35, SEA, { categories: ["fish"], allergens: ["fish"], default: true }),
  S("tuna-canned-in-water-light", "protein", "oz", 28.35, SEA, { categories: ["fish"], allergens: ["fish"], default: true }),
  S("cod-cooked", "protein", "oz", 28.35, SEA, { categories: ["fish"], allergens: ["fish"] }),
  S("egg-white", "protein", "cup", 243, ANIMAL, { allergens: ["egg"], default: true }),
  S("whey-protein-powder", "protein", "cup", 96, ANIMAL, { allergens: ["dairy"], default: true }),
  // Breakfast anchors (Phase 17 O1): without them a new account's 07:30 plate had only egg white,
  // whey or tofu to lead it.
  S("egg-whole-large", "protein", "whole", 50, ANIMAL, { allergens: ["egg"], default: true }),
  S("greek-yogurt-plain-nonfat", "protein", "cup", 245, ANIMAL, { allergens: ["dairy"], default: true }),
  S("tofu-firm", "protein", "oz", 28.35, ALL, { allergens: ["soy"], default: true }),
  S("tempeh", "protein", "oz", 28.35, ALL, { allergens: ["soy"], default: true }),
  S("edamame-cooked", "protein", "cup", 155, ALL, { allergens: ["soy"], categories: ["beans"], default: true }),
  S("lentils-cooked", "protein", "cup", 198, ALL, { categories: ["beans"], default: true }),
  S("black-beans-cooked", "protein", "cup", 172, ALL, { categories: ["beans"], default: true }),
  S("chickpeas-cooked", "protein", "cup", 164, ALL, { categories: ["beans"] }),
  S("white-beans-cooked", "protein", "cup", 179, ALL, { categories: ["beans"] }),
  S("white-rice-cooked", "carb", "cup", 158, ALL, { default: true }),
  S("brown-rice-cooked", "carb", "cup", 195, ALL, { default: true }),
  S("quinoa-cooked", "carb", "cup", 185, ALL, { default: true }),
  S("oatmeal-cooked", "carb", "cup", 234, ALL, { default: true }),
  S("potato-baked-with-skin", "carb", "whole", 173, ALL, { default: true }),
  S("sweet-potato-baked", "carb", "whole", 114, ALL, { default: true }),
  S("banana", "carb", "whole", 118, ALL, { default: true }),
  S("apple-with-skin", "carb", "whole", 182, ALL, { allergens: ["apple"], categories: ["apple"] }),
  S("white-bread", "carb", "whole", 29, ALL, { allergens: ["wheat", "gluten"], categories: ["gluten"] }),
  S("corn-tortilla", "carb", "whole", 26, ALL),
  S("whole-wheat-bread", "carb", "whole", 32, ALL, { allergens: ["wheat", "gluten"], categories: ["gluten"] }),
  S("blueberries", "carb", "cup", 148, ALL, { default: true }),
  // Vegetables (role carb, as the layout counts them): a main plate takes one whenever Eats has it.
  S("broccoli-cooked", "carb", "cup", 156, ALL, { default: true }),
  S("green-beans-cooked", "carb", "cup", 125, ALL, { default: true }),
  S("spinach-cooked", "carb", "cup", 180, ALL),
  S("olive-oil", "fat", "tbsp", 13.5, ALL, { default: true }),
  S("avocado-oil", "fat", "tbsp", 13.5, ALL, { default: true }),
  S("avocado", "fat", "cup", 150, ALL, { default: true }),
  S("peanut-butter", "fat", "tbsp", 16, ALL, { allergens: ["peanut"], default: true }),
  S("almonds", "fat", "oz", 28.35, ALL, { allergens: ["tree-nut"], default: true }),
  S("pumpkin-seeds", "fat", "oz", 28.35, ALL, { default: true }),
  S("butter", "fat", "tbsp", 14.2, ANIMAL, { allergens: ["dairy"] }),
];

export function starterForName(name: string): Starter | undefined {
  return STARTERS.find((item) => dbFood(item.id)?.name.toLowerCase() === name.toLowerCase());
}

/** Curated household weight when the generic unit table lacks this starter's portion. */
export function starterPortionGrams(name: string, unit: FoodUnit): number | null {
  const item = starterForName(name);
  return item?.unit === unit ? item.grams : null;
}

export function dietStyle(flags: readonly string[]): DietStyle {
  if (flags.includes("vegan")) return "vegan";
  if (flags.includes("vegetarian")) return "vegetarian";
  if (flags.includes("pescatarian")) return "pescatarian";
  return "omnivore";
}

/**
 * One concern per allergen for a starter: wheat and gluten are the same concern here (W014, audit
 * 2026-10-10 A041), so an account that avoids either never sees a starter tagged with the other.
 */
function allergenConcern(name: string): string {
  const key = allergenKey(name);
  return key === "wheat" ? "gluten" : key;
}

/**
 * The allergen/category/hard-rule exclusion check alone — not diet style, which `starterChoices`
 * filters separately. Factored out so the just-before-write recheck in
 * `lib/foods/starter-client.ts` (ONB2-RULE-REREAD-WRITE) can apply the IDENTICAL predicate against
 * a freshly re-read profile+instances, instead of a hand-rolled approximation that could drift.
 */
function starterPassesRuleSets(
  item: Starter, bannedCategories: ReadonlySet<string>, avoidAllergens: ReadonlySet<string>,
  instances: readonly ProfileInstance[], asOf: Date,
): boolean {
  return !(item.categories ?? []).some((key) => bannedCategories.has(key))
    && !(item.allergens ?? []).some((key) => avoidAllergens.has(allergenConcern(key)))
    && dbFood(item.id) !== undefined
    && instances.every((instance) => instance.rules.every((rule) =>
      !isActiveHardRule(rule, asOf) || (starterFacetOutcome(item, rule.facet) ?? profileFacetOutcome(rule.facet, {
        // The bundled name may name a facet, but it is not a label and clears nothing here: only
        // the starter's own curated evidence (starterFacetOutcome) can (Phase 18 W2c).
        foodName: dbFood(item.id)?.name, wholeFoodName: null,
        ingredientsText: dbFood(item.id)?.name, ingredientsTextIsLabel: false,
      })) === "absent"));
}

/** Absence of a loaded profile must never mean that allergens are clear. */
export function starterChoices(flags: readonly string[], profile: Profile,
  instances: readonly ProfileInstance[] = [], asOf: Date = new Date()): Starter[] {
  // This local catalog has no food-ref IDs; an unresolved ID rule cannot be waived by a name.
  if (profile.avoid_food_ref_ids.length) return [];
  const style = dietStyle(flags);
  const banned = new Set(profile.banned_categories.map((x) => x.toLowerCase()));
  const allergens = new Set(profile.avoid_allergens.map(allergenConcern));
  for (const flag of flags) {
    const key = ({ no_shellfish: "shellfish", no_eggs: "egg", no_soy: "soy", no_peanuts: "peanut" } as Record<string, string>)[flag];
    if (key) allergens.add(allergenConcern(key));
  }
  if (flags.includes("low_fodmap")) banned.add("beans");
  if (flags.includes("no_pork") || flags.includes("halal") || flags.includes("kosher")) banned.add("pork");
  if (flags.includes("no_beef")) banned.add("beef");
  // No certification data exists for meat; halal/kosher suggestions use plant, eggs and fish only.
  if (flags.includes("halal") || flags.includes("kosher")) { banned.add("beef"); banned.add("poultry"); }
  return STARTERS.filter((item) => item.diets.includes(style)
    && starterPassesRuleSets(item, banned, allergens, instances, asOf));
}

/**
 * The same allergen/category/hard-rule check `starterChoices` applies, but against the account's
 * CURRENT profile directly (no diet-style filter, no flag-derived bans merged in) — for a
 * just-before-write recheck where only the stored profile+instances could have changed, not the
 * draft's own flags. Returns true when the item is now excluded and must not be written as "eats".
 */
export function starterExcludedByCurrentRules(
  item: Starter, profile: Profile, instances: readonly ProfileInstance[], asOf: Date = new Date(),
): boolean {
  const banned = new Set(profile.banned_categories.map((x) => x.toLowerCase()));
  const allergens = new Set(profile.avoid_allergens.map(allergenConcern));
  return !starterPassesRuleSets(item, banned, allergens, instances, asOf);
}

export function starterDefaultIds(choices: readonly Starter[]): string[] {
  return choices.filter((item) => item.default).map((item) => item.id);
}

export type StarterMark = "eats" | "avoid" | "neutral";
export type InitialStarterOptions = {
  /**
   * true (the legacy grid's default): every curated default starts marked "eats", and the user
   * reviews the whole visible grid before saving. false: nothing is pre-marked; only the user's
   * own taps, foods named in their text and their saved foods start marked. A surface that does
   * not show every pre-marked food (onboarding v2's falling pile) must pass false, or every
   * default it never showed is saved as a liked food (2026-10-07 QA: 29 Eats nobody chose).
   */
  preselectDefaults?: boolean;
};

export function initialStarterSelection(
  flags: readonly string[], profile: Profile, prefsText: string,
  instances: readonly ProfileInstance[] = [], existingFoods: readonly Food[] = [],
  options: InitialStarterOptions = {},
): Record<string, StarterMark> {
  const choices = starterChoices(flags, profile, instances);
  const preselect = options.preselectDefaults ?? true;
  const marks: Record<string, StarterMark> = preselect ? Object.fromEntries(
    starterDefaultIds(choices).map((id) => [id, "eats"])) : {};
  const allowed = new Set(choices.map((item) => item.id));
  for (const [id, status] of mentionedFoodChoices(prefsText, STARTERS)) {
    if (status === "avoid" || allowed.has(id)) marks[id] = status;
  }
  // Reopening setup must not replace explicit account choices with starter suggestions.
  for (const food of [...existingFoods].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    const item = starterForName(food.name);
    if (!item) continue;
    // Withhold ineligible suggestions without silently changing the saved membership.
    if (food.status === "eats" && !allowed.has(item.id)) delete marks[item.id];
    else marks[item.id] = food.status;
  }
  return marks;
}

/**
 * "Pick for me" without overriding the user: the ids to add so that every role reaches the
 * two-per-role floor `starterSelectionValid` asks for, or the higher count `need` names for a role
 * (a legacy plan needs one distinct protein per planned meal; a number applies to every role).
 * Roles already at their count get nothing; a food the user liked or avoided is never re-marked,
 * and neither is any id in `skip` — the foods the person tapped off in this flow (GPT-6 Sol WARN
 * onb2-p0). A `neutral` mark alone stays available: a saved food the account left neutral (a
 * re-opened setup) is not a tap-off. Curated defaults come first in catalog order, then any other
 * allowed food of that role. Returns [] when every role is already covered, and fewer than asked
 * when the allowed foods run out (the caller checks the result). Pure.
 */
export function starterFillShortRoles(
  choices: readonly Starter[], marks: Readonly<Record<string, StarterMark>>,
  need: number | Partial<Record<FoodRole, number>> = 2,
  skip: ReadonlySet<string> = new Set(),
  /** Reorders a role's open foods (defaults first, then catalog order) before the fill takes the
   *  first ones; onboarding v2 passes `starterFillOrder` (lib/foods/starter-variety.ts) so the
   *  picks cover plate parts, not two starches. Absent: that default order. */
  order?: (open: Starter[], choices: readonly Starter[], marks: Readonly<Record<string, StarterMark>>) => Starter[],
): string[] {
  const added: string[] = [];
  for (const role of ["protein", "carb", "fat"] as const) {
    const target = Math.max(2, typeof need === "number" ? need : need[role] ?? 2);
    const ofRole = choices.filter((item) => item.role === role);
    const have = ofRole.filter((item) => marks[item.id] === "eats").length;
    const open = ofRole.filter((item) => !skip.has(item.id)
      && (marks[item.id] === undefined || marks[item.id] === "neutral"));
    const byDefault = [...open.filter((item) => item.default), ...open.filter((item) => !item.default)];
    const ordered = order ? order(byDefault, choices, marks) : byDefault;
    added.push(...ordered.slice(0, Math.max(0, target - have)).map((item) => item.id));
  }
  return added;
}

export function starterSelectionValid(ids: readonly string[], choices: readonly Starter[]): boolean {
  const selected = new Set(ids);
  return (["protein", "carb", "fat"] as const).every((role) =>
    choices.filter((item) => item.role === role && selected.has(item.id)).length >= 2);
}

export function starterFood(id: string, status: FoodStatus): Food {
  const item = STARTERS.find((candidate) => candidate.id === id);
  const db = dbFood(id);
  if (!item || !db) throw new Error(`Unknown starter food: ${id}`);
  const factor = item.grams / 100;
  return { id: `starter:${id}`, name: db.name, role: item.role, unit: item.unit,
    perUnit: { protein: db.per100g.protein * factor, carbs: db.per100g.carbs * factor, fat: db.per100g.fat * factor },
    status, updatedAt: new Date(0).toISOString() };
}

/** Only explicit sentiment near a food name changes its suggested selection. */
export function mentionedFoodChoices(text: string, choices: readonly Starter[]): Map<string, "eats" | "avoid"> {
  const found = new Map<string, "eats" | "avoid">();
  const clauses = text.toLowerCase().split(/[,.;]|\band\b/);
  for (const item of choices) {
    const name = dbFood(item.id)?.name.toLowerCase();
    if (!name) continue;
    const aliases = [name, name.split(",")[0], item.id.replace(/-(cooked|roasted|with-skin)$/, "").replaceAll("-", " ")];
    for (const clause of clauses) {
      for (const alias of aliases) {
        if (alias.length < 4 || !clause.includes(alias)) continue;
        const at = clause.indexOf(alias);
        const before = clause.slice(Math.max(0, at - 40), at);
        const after = clause.slice(at + alias.length, at + alias.length + 28);
        const avoid = /\b(don'?t|do not)\s+(?:eat|like)\s+(?:\w+\s+){0,2}$/.test(before)
          || /\b(allergic to|avoid|hate)\s+(?:\w+\s+){0,2}$/.test(before)
          || /\bno\s+(?:\w+\s+)?$/.test(before)
          || /^\s+(?:\w+\s+){0,2}(?:hate|avoid)\b/.test(after);
        const eat = /\b(love|like|more|eat)\s+(?:\w+\s+){0,2}$/.test(before)
          || /^\s+(?:\w+\s+){0,2}(?:love|like)\b/.test(after);
        if (avoid) found.set(item.id, "avoid");
        else if (eat && found.get(item.id) !== "avoid") found.set(item.id, "eats");
        break;
      }
    }
  }
  return found;
}
