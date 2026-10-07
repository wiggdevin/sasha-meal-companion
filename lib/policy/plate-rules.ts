/**
 * Meal-level rules (Phase 18 D4, W2b): a rule about a combination, which a food-by-food verdict
 * cannot see. Kosher meat with dairy is the first. For a kosher account no generated plate holds a
 * food with deterministic meat evidence beside a food with deterministic dairy evidence, and a plate
 * whose foods cannot be proved apart is not generated: every food on it needs known meat AND dairy
 * evidence. W8 calls `checkPlateRules` inside the plate search; it never loosens a food's own
 * verdict (`evaluatePolicy` still decides each food first).
 *
 * Evidence is deterministic only (never Jev): dairy from the allergen rules (stored evidence, tags,
 * ingredient or label text, the food's name, the whole-food class); meat from the whole-food class
 * and meat words in the name or ingredient text. Fish and eggs are not meat here (pareve).
 *
 * Pure. No I/O.
 */
import { allergenFinding, type StoredAllergenEvidence } from "@/lib/policy/allergens";
import type { FacetOutcome, PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { classifyWholeFood, clearanceNameOf } from "@/lib/policy/whole-foods";

export type PlateFoodEvidence = Readonly<{ meat: FacetOutcome; dairy: FacetOutcome }>;

export type PlateFoodInput = Readonly<{
  foodName?: string | null;
  /** The name the whole-food class reads (lib/policy/whole-foods.ts clearanceNameOf). */
  wholeFoodName?: string | null;
  ingredientsText?: string | null;
  allergenTags?: readonly string[] | null;
  /** Stored evidence for the dairy allergen, when the caller has it. */
  dairyEvidence?: StoredAllergenEvidence;
  brand?: string | null;
  packaged?: boolean;
}>;

const MEAT_WORDS = new RegExp("\\b(?:meat|meats|beef|pork|veal|lamb|mutton|goat|venison|bison|chicken|turkey|"
  + "duck|goose|hen|ham|bacon|sausages?|salami|pepperoni|chorizo|prosciutto|pastrami|jerky|"
  + "hot dogs?|frankfurters?|meatballs?|gelatin|lard|tallow|suet|broth|stock)\\b", "i");
const MEAT_CLASSES = new Set(["poultry", "red meat"]);
/** Classes that cannot be meat: plant foods, eggs, dairy, fish and shellfish. */
const NOT_MEAT_CLASSES = new Set(["water", "plant oil", "grain", "oats", "potato", "corn", "legume", "soy",
  "tree nuts", "peanuts", "sesame", "seeds", "vegetables", "fruit", "egg", "dairy", "fish", "shellfish"]);

function meatOutcome(input: PlateFoodInput): FacetOutcome {
  const named = [input.foodName, input.ingredientsText].some((text) => text && MEAT_WORDS.test(text));
  const match = classifyWholeFood({ foodName: clearanceNameOf(input), brand: input.brand,
    ingredientsText: input.ingredientsText, packaged: input.packaged });
  if (named || (match && MEAT_CLASSES.has(match.label))) return "present";
  return match && NOT_MEAT_CLASSES.has(match.label) ? "absent" : "unknown";
}

/** One food's deterministic meat and dairy evidence. */
export function plateFoodEvidence(input: PlateFoodInput): PlateFoodEvidence {
  const dairy = allergenFinding("dairy", { stored: input.dairyEvidence, tags: input.allergenTags,
    ingredientsText: input.ingredientsText, foodName: input.foodName, wholeFoodName: input.wholeFoodName,
    brand: input.brand, packaged: input.packaged });
  return { meat: meatOutcome(input), dairy: dairy.outcome };
}

export type PlateRuleVerdict =
  | { ok: true }
  | { ok: false; rule: "kosher_meat_dairy"; reason: "meat_with_dairy" | "unproven" };

/** The meal-level verdict for one assembled plate under the account's confirmed diet flags. */
export function checkPlateRules(flags: readonly PolicyPreferenceFlag[],
  foods: readonly PlateFoodEvidence[]): PlateRuleVerdict {
  if (!flags.includes("kosher")) return { ok: true };
  if (foods.some((food) => food.meat === "present") && foods.some((food) => food.dairy === "present")) {
    return { ok: false, rule: "kosher_meat_dairy", reason: "meat_with_dairy" };
  }
  if (foods.some((food) => food.meat === "unknown" || food.dairy === "unknown")) {
    return { ok: false, rule: "kosher_meat_dairy", reason: "unproven" };
  }
  return { ok: true };
}
