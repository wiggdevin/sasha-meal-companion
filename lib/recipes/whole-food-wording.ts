/**
 * 2026-10-03: which name whole-food clearance may read for one recipe line. Fail-closed by design
 * (two independent safety audits of PR #333): a line clears only when its wording is an explicit,
 * known plain food — optionally wrapped in a closed set of doneness and cut words — AND its catalog
 * row is that SAME food. Nothing is stripped from free text and then guessed at: "grilled cheese",
 * "baked beans", "couscous" against a quinoa row, or "coconut" against a lemon row never clear.
 *
 * Adding a food here is a reviewed safety change: give it a wording head, the catalog head the
 * row must start with, and a negative test. Pure. No I/O.
 */
import { classifyWholeFood, namesPreparedOrCompound } from "@/lib/policy/whole-foods";

type PlainFood = { wording: RegExp; catalog: RegExp };

/** One row per plain food a recipe line may name. `catalog` anchors the row's own head segments. */
const PLAIN_FOODS: Readonly<Record<string, PlainFood>> = {
  chicken: { wording: /^chicken(?: breasts?| thighs?)?$/, catalog: /^chicken, (?:broilers or fryers, )?(?:breast|thigh)/ },
  salmon: { wording: /^salmon$/, catalog: /^fish, salmon, / },
  egg: { wording: /^eggs?$/, catalog: /^egg, whole, / },
  quinoa: { wording: /^quinoa$/, catalog: /^quinoa, cooked$/ },
  broccoli: { wording: /^broccoli$/, catalog: /^broccoli, / },
  spinach: { wording: /^spinach$/, catalog: /^spinach, / },
  carrot: { wording: /^carrots?$/, catalog: /^carrots, raw$/ },
  tomato: { wording: /^tomato(?:es)?$/, catalog: /^tomatoes, red, ripe, raw, / },
  lemon: { wording: /^lemons?$/, catalog: /^lemons, raw, without peel$/ },
  "olive oil": { wording: /^olive oil$/, catalog: /^oil, olive, salad or cooking$/ },
  water: { wording: /^water$/, catalog: /^water, bottled, generic$/ },
  sirloin: { wording: /^sirloin steak$/, catalog: /^beef, top sirloin, steak, separable lean only, / },
};

/** Doneness and cut words allowed around a plain-food head: before it, or as comma segments after. */
const ALLOWED = "cooked|roasted|baked|broiled|grilled|steamed|boiled|hard-boiled|raw|fresh|diced|sliced|chopped|cubed|peeled";
const LEADING = new RegExp(`^(?:(?:${ALLOWED})\\s+)*`);
const TRAILING = new RegExp(`(?:,\\s*(?:${ALLOWED}))*$`);

/**
 * Processed or prepared forms refused even when lib/policy/whole-foods.ts PREPARED misses them
 * (DeepSeek, PR #333): any of these anywhere in the wording rules clearance out.
 */
const PROCESSED = /\b(?:bread(?:ed|ing)?|batter(?:ed)?|marinat(?:ed|e)|season(?:ed|ing)?|glaze[ds]?|smoked|cured|candied|sweetened|flavou?red|infused|ready[\s-]to[\s-](?:eat|serve|heat|cook)|store[\s-]bought|deli|pre-?cooked|pre-?made|instant|rotisserie|packaged|jarred|sandwich(?:es)?|toast|pies?)\b/i;

/** The plain food a wording names, or null when anything beyond a head and allowed words remains. */
export function plainFoodOf(wording: string): string | null {
  const lower = wording.toLowerCase().replace(/\s+/g, " ").trim();
  if (PROCESSED.test(lower) || namesPreparedOrCompound(lower)) return null;
  const head = lower.replace(LEADING, "").replace(TRAILING, "").trim();
  return Object.keys(PLAIN_FOODS).find((food) => PLAIN_FOODS[food].wording.test(head)) ?? null;
}

/**
 * The catalog description when the wording names that same plain food and the row is itself a
 * plain whole food whose intrinsic allergens cover everything the wording's own food carries.
 * Otherwise null: no clearance, every escalation still runs on the joined name.
 */
export function wholeFoodNameForWording(wording: string,
  description: string | null | undefined): string | null {
  if (!description) return null;
  const food = plainFoodOf(wording);
  if (!food || !PLAIN_FOODS[food].catalog.test(description.toLowerCase().trim())) return null;
  const row = classifyWholeFood({ foodName: description });
  const own = classifyWholeFood({ foodName: wording.toLowerCase().replace(LEADING, "")
    .replace(TRAILING, "").trim() });
  if (!row || !own) return null;
  return own.intrinsic.every((key) => row.intrinsic.includes(key)) ? description : null;
}
