/**
 * The complement step of composeMeal (lib/coach/compose.ts): one food off the account's own Eats list
 * to cover a macro the wish's foods cannot. Split out to keep compose.ts under the 400-line cap.
 */
import type { FoodHit } from "@/lib/coach/executors";
import { macroSources, roleOf, type Role } from "@/lib/coach/compose-size";
import { checkItem, allergenFacts } from "@/lib/coach/policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { classifyWholeFood } from "@/lib/policy/whole-foods";
import { isEatsRow, POUCH, type ComposePorts } from "@/lib/coach/compose";

/** How many of their Eats foods the composer will search before giving up on an addition. */
export const COMPLEMENT_TRIES = 8;
/** Hits read per name when only the account's own Eats row will do (compose-template ROW_SEARCH). */
export const EATS_ROW_SEARCH = 3;

const CARB_CLASSES = new Set(["grain", "oats", "potato", "corn", "legume", "fruit"]);
const FAT_CLASSES = new Set(["plant oil", "tree nuts", "peanuts", "seeds", "sesame"]);
const FAT_FRUIT = /^(?:avocados?|coconuts?)\b/i;

/**
 * Their Eats names with the plain whole foods of the needed role first, read off the name alone
 * (no search). Live trace 2026-10-02: the first eight names of an alphabetical 78-food list were
 * all almond butters and avocados, so no carb was ever tried and no card reached its target.
 */
export function complementOrder(eats: string[], need: "fat" | "carbs"): string[] {
  return [...eats.filter((name) => fillsRole(name, need)),
    ...eats.filter((name) => !fillsRole(name, need))];
}

/** Whether a name reads as a plain whole food of the needed role (lib/policy/whole-foods.ts). */
export function fillsRole(name: string, need: "fat" | "carbs"): boolean {
  const label = classifyWholeFood({ foodName: name })?.label;
  if (label === undefined) return false;
  if (label === "fruit") return need === "fat" ? FAT_FRUIT.test(name) : !FAT_FRUIT.test(name);
  return (need === "fat" ? FAT_CLASSES : CARB_CLASSES).has(label);
}

/**
 * One food off THEIR list to cover a macro the wish's own foods cannot. Never the catalog, never a
 * food on their Avoid list, never a pouch, and never one already on the card. The first of their foods
 * whose own dominant macro IS the missing one wins, so a fat gap is filled by a fat.
 *
 * And never a SECOND source of a macro the sized meal already COVERS (ruling 2026-09-18):
 * "chicken wrap" asked for a fat and got 65 g of ground beef, which is a fat by its dominant macro
 * and a protein by a third of its energy, so the meal came back 22 g over on protein. `covered` is
 * read off the sized totals, not off which foods the wish named — a meal short on protein and fat
 * at once still wants a salmon.
 */
export async function pickComplement(
  userId: string,
  need: "fat" | "carbs",
  eats: string[],
  used: Set<string>,
  covered: Set<Role>,
  profile: ConstraintProfile,
  ports: ComposePorts,
  /** A suggestion card is discarded by any item that is not allowed (live trace 2026-10-02), so
   *  its complement passes over an unverified food for the next one; a direct composition marks. */
  allowedOnly = false,
): Promise<FoodHit | null> {
  const role: Role = need === "fat" ? "fat" : "carb";
  // One food once, whatever the catalog calls it: "Banana, medium" and "Banana, raw" are one banana.
  const headOf = (name: string) => name.split(",")[0].trim().toLowerCase();
  const usedHeads = new Set([...used].map(headOf));
  for (const name of complementOrder(eats, need).slice(0, COMPLEMENT_TRIES)) {
    if (used.has(name.toLowerCase()) || usedHeads.has(headOf(name))) continue;
    // A suggestion card's food is the account's own Eats row for that name, not a catalog twin
    // the search ranked first (2026-10-03 audit, BLOCKER 1). It looks past that twin to the Eats
    // row, as compose-template's ownRow does (re-audit r2 #6); a direct composition takes the top hit.
    const limit = allowedOnly ? EATS_ROW_SEARCH : 1;
    const [hit] = (await ports.searchFoods(userId, name, limit)).filter((row) =>
      row.foodRefId !== null && row.prefStatus !== "avoid" && !POUCH.test(row.name)
      && (!allowedOnly || isEatsRow(row, name)));
    if (!hit || used.has(hit.name.toLowerCase()) || usedHeads.has(headOf(hit.name))) continue;
    if (roleOf(hit) !== role) continue;
    const doubles = [...macroSources(hit)].some((m) => m !== role && covered.has(m));
    if (doubles) continue;
    const verdict = checkItem({
      foodRefId: hit.foodRefId, name: hit.name, grams: null,
      allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
      onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
    }, profile).verdict;
    if (verdict === "blocked" || (allowedOnly && verdict !== "allowed")) continue;
    return hit;
  }
  return null;
}
