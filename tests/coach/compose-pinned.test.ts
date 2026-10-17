/**
 * Phase 18 W9 (D12, O4b): `compose_meal` rebuilt on `rankPinnedPlates`, the pinned, one-slot
 * entry into the SAME plate search the daily layout and swap sheet use. These are the O4 re-plan
 * regression cases from the spec's acceptance 1 list: a representative set, each driven through
 * the real `composeMeal` (not a hand-derived expectation), plus acceptance 2 (incoherent ->
 * incomplete), 3 (a pinned food outside the pool still searched and still policy-checked) and 4
 * (the occasion phrase never eats into the four-term cap).
 */
import { describe, expect, it, vi } from "vitest";
import { composeMeal, wishTerms } from "@/lib/coach/compose";
import { parseOccasionPhrase } from "@/lib/meals/occasion-phrase";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { FoodHit } from "@/lib/coach/executors";

const REF = (n: string) => `3f1b1a2c-0000-4000-8000-0000000000${n}`;
const TARGET = { kcal: 500, protein: 30, carbs: 50, fat: 15 };

/**
 * `TEST_PROFILE` (shared across the coach suites) avoids dairy, gluten and literally "apple" —
 * exactly two of the foods the O4 regression list names ("yogurt", "apple with peanut butter").
 * These cases are about plate COHERENCE, not policy (acceptance 3 covers policy separately with
 * `TEST_PROFILE` on purpose), so they use a profile with nothing to avoid.
 */
const OPEN_PROFILE: ConstraintProfile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] };

/** A search hit for a plain food, per-100g, Favored (the account's own Eats row). */
function eatsHit(ref: string, name: string, per100: [number, number, number]): FoodHit {
  const [protein, carbs, fat] = per100;
  return { foodRefId: REF(ref), name, brand: null, prefStatus: "eats",
    kcalPer100g: protein * 4 + carbs * 4 + fat * 9, proteinPer100g: protein, carbsPer100g: carbs,
    fatPer100g: fat, catalogFoodRevisionId: null, allergenTags: [], category: null };
}

const paneer = eatsHit("p1", "Paneer", [18, 3, 20]);
const rice = eatsHit("r1", "Rice, white, cooked", [2.7, 28, 0.3]);
const yogurt = eatsHit("y1", "Greek yogurt, plain, nonfat", [10, 3.6, 0.4]);
const carrots = eatsHit("c2", "Carrots, cooked", [0.8, 8, 0.2]);
const oats = eatsHit("o1", "Oats, rolled", [13, 68, 6.5]);
const apple = eatsHit("a1", "Apple", [0.3, 14, 0.2]);
const peanutButter = eatsHit("pb1", "Peanut butter", [25, 20, 50]);
const tuna = eatsHit("t1", "Tuna, canned in water", [25, 0, 1]);
const banana = eatsHit("b1", "Banana", [1.1, 23, 0.3]);
const chicken = eatsHit("ch1", "Chicken breast, roasted", [31, 0, 3.6]);
const avoidedShrimp: FoodHit = { ...eatsHit("sh1", "Shrimp", [24, 0, 0.3]), prefStatus: "avoid" };

function portsFor(byName: Record<string, FoodHit[]>, eats: readonly string[] = []): {
  searchFoods: (u: string, q: string, l?: number) => Promise<FoodHit[]>;
  eatsNames: () => Promise<string[]>;
} {
  return {
    searchFoods: vi.fn(async (_u: string, q: string) => byName[q] ?? []),
    eatsNames: async () => [...eats],
  };
}

describe("acceptance 1: O4 regression cases, through the real composeMeal", () => {
  it("paneer anchors a main plate (a non-protein-role food the account marked dense enough)", async () => {
    const meal = await composeMeal("u1", { wish: "paneer with rice", target: TARGET }, OPEN_PROFILE,
      portsFor({ paneer: [paneer], rice: [rice] }));
    expect(meal.incomplete).toBeUndefined();
    const names = meal.items.map((item) => item.name);
    expect(names).toContain("Paneer");
    expect(names).toContain("Rice, white, cooked");
    expect(meal.items.find((item) => item.name === "Paneer")?.part).toBe("anchor");
  });

  it("yogurt with carrots: a named vegetable layers onto the pool-filled starch a main needs", async () => {
    // "Carrots" is a VEGETABLE part (lib/meals/parts.ts), never a starch — the main template
    // still needs a starch or fruit from somewhere (D12: "fills missing parts from the admitted
    // pool"), so this names the vegetable and lets a Favored starch (oats) fill the rest.
    const meal = await composeMeal("u1", { wish: "yogurt with carrots", target: TARGET },
      OPEN_PROFILE, portsFor({ yogurt: [yogurt], carrots: [carrots], "Oats, rolled": [oats] },
        ["Oats, rolled"]));
    expect(meal.incomplete).toBeUndefined();
    expect(meal.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Greek yogurt, plain, nonfat", "Carrots, cooked"]));
  });

  it("yogurt with oats: a dairy anchor with its usual breakfast starch", async () => {
    const meal = await composeMeal("u1", { wish: "yogurt with oats", target: TARGET },
      OPEN_PROFILE, portsFor({ yogurt: [yogurt], oats: [oats] }));
    expect(meal.incomplete).toBeUndefined();
    expect(meal.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Greek yogurt, plain, nonfat", "Oats, rolled"]));
  });

  it("apple with peanut butter: the anchorless snack (fruit + fat, no anchor at all)", async () => {
    // `wishTerms` has no multi-word vocabulary, only a word cap: "peanut butter" searches as
    // "peanut" and "butter" separately, same as any other two-word food name.
    const meal = await composeMeal("u1",
      { wish: "apple with peanut butter", target: { kcal: 300, protein: 10, carbs: 30, fat: 12 } },
      OPEN_PROFILE, portsFor({ apple: [apple], peanut: [peanutButter], butter: [peanutButter] }));
    expect(meal.incomplete).toBeUndefined();
    expect(meal.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Apple", "Peanut butter"]));
    expect(meal.items.every((item) => item.part !== "anchor")).toBe(true);
  });

  it("apple with peanut butter FOR DINNER: the anchorless snack stays a small-snack rule, never a dinner (W9 re-plan)", async () => {
    // Same two foods, but an explicit dinner phrase and a full dinner-sized target: the
    // anchorless template is still small-snack-only (D4, same rule as plain `rankPlates`), so a
    // named combination gets no looser a rule just for being user-chosen.
    const meal = await composeMeal("u1", { wish: "apple with peanut butter for dinner", target: TARGET },
      OPEN_PROFILE, portsFor({ apple: [apple], peanut: [peanutButter], butter: [peanutButter] }));
    expect(meal.mealType === "dinner" || meal.incomplete !== undefined).toBe(true);
    expect(meal.incomplete).toBeDefined();
  });

  it("catalog twins: the marked row wins over an unmarked twin of the same name", async () => {
    const markedChicken = eatsHit("ch2", "Chicken breast, roasted", [31, 0, 3.6]);
    const catalogTwin: FoodHit = { ...eatsHit("ch3", "Chicken breast, roasted", [30, 0, 4]), prefStatus: null };
    const meal = await composeMeal("u1", { wish: "chicken with rice", target: TARGET },
      OPEN_PROFILE, portsFor({
        // The catalog twin is returned FIRST; the marked row must still win (D12, the marked-row
        // adapter), not whichever hit the search happened to list first.
        chicken: [catalogTwin, markedChicken], rice: [rice],
      }, ["Chicken breast, roasted"]));
    const chickenItem = meal.items.find((item) => item.name === "Chicken breast, roasted");
    expect(chickenItem).toBeDefined();
    expect(chickenItem?.foodRefId).toBe(markedChicken.foodRefId);
  });

  it("a 10:30 slot clock: the boundary minute reads as lunch, not breakfast", async () => {
    // `args.slotClock` is exactly the "HH:MM" `coach-ports.ts`'s compose port reads off a saved
    // slot's own resolved day context (ContextSlot.time) -- this is composeMeal's own contract
    // for that value, not a day-context integration test.
    const meal = await composeMeal("u1",
      { wish: "chicken with rice", target: TARGET, slot: "meal-2", slotClock: "10:30" },
      OPEN_PROFILE, portsFor({ chicken: [chicken], rice: [rice] }));
    expect(meal.mealType).toBe("lunch");
    expect(meal.incomplete).toBeUndefined();
  });

  it("cooked oatmeal band: a named COOKED porridge sizes to its bowl band, not dry oats' band", async () => {
    // lib/meals/parts.ts's COOKED_PORRIDGE correction: a name matching "oatmeal"/"porridge" +
    // "cooked" gets the 120-350 g bowl band, not the curated 30-90 g dry-oats band — the exact
    // regression this named acceptance case is about.
    const eggs = eatsHit("e1", "Eggs, whole, cooked", [12.6, 0.7, 9.5]);
    const cookedOatmeal = eatsHit("oatm1", "Oatmeal, cooked", [2.5, 12, 1.5]);
    const meal = await composeMeal("u1",
      { wish: "eggs with oatmeal", target: TARGET, slot: "meal-1", slotClock: "07:30" },
      OPEN_PROFILE, portsFor({ eggs: [eggs], oatmeal: [cookedOatmeal] }));
    expect(meal.mealType).toBe("breakfast");
    expect(meal.incomplete).toBeUndefined();
    const oatmealItem = meal.items.find((item) => item.name === "Oatmeal, cooked");
    expect(oatmealItem).toBeDefined();
    // Inside the bowl band (120-350 g, with the band's own 0.8x lower allowance) and clearly past
    // dry rolled oats' 30-90 g band, proving the cooked-porridge correction actually applied.
    expect(oatmealItem?.grams).toBeGreaterThanOrEqual(96);
    expect(oatmealItem?.grams).toBeLessThanOrEqual(350);
  });

  it("'for brunch': brunch reads as breakfast (the one word MEAL_OF maps it to)", async () => {
    const eggs = eatsHit("e2", "Eggs, whole, cooked", [12.6, 0.7, 9.5]);
    const meal = await composeMeal("u1", { wish: "eggs with oats for brunch", target: TARGET },
      OPEN_PROFILE, portsFor({ eggs: [eggs], oats: [oats] }));
    expect(meal.mealType).toBe("breakfast");
    expect(meal.incomplete).toBeUndefined();
  });

  it("rice alone, with no admitted anchor anywhere: stays incomplete", async () => {
    // "rice" alone names no anchor; the main template still requires one, and the pool has
    // nothing that can take it — no coherent plate exists.
    const meal = await composeMeal("u1", { wish: "rice", target: TARGET }, OPEN_PROFILE,
      portsFor({ rice: [rice] }));
    expect(meal.incomplete).toBeDefined();
    expect(meal.items.map((item) => item.name)).toEqual(["Rice, white, cooked"]);
  });

  it("rice needing chicken: a starch named alone fills its anchor FROM THE POOL (D12, W9 re-plan)", async () => {
    // Same wish, but chicken is now Favored (on the Eats list): D12 "fills missing parts from
    // the admitted pool" applies to the anchor part too, not only the sides — `rice` alone still
    // composes a real, coherent plate once an anchor is actually available to fill it.
    const meal = await composeMeal("u1", { wish: "rice", target: TARGET }, OPEN_PROFILE,
      portsFor({ rice: [rice], chicken: [chicken], "Chicken breast, roasted": [chicken] },
        ["Chicken breast, roasted"]));
    expect(meal.incomplete).toBeUndefined();
    const names = meal.items.map((item) => item.name);
    expect(names).toContain("Rice, white, cooked");
    expect(names).toContain("Chicken breast, roasted");
    const anchorItem = meal.items.find((item) => item.part === "anchor");
    expect(anchorItem?.name).toBe("Chicken breast, roasted");
  });

  it("a meal-only 'breakfast': the occasion phrase alone, no food named, composes nothing", async () => {
    const meal = await composeMeal("u1", { wish: "breakfast", target: TARGET }, OPEN_PROFILE,
      portsFor({}));
    expect(meal.items).toEqual([]);
    expect(meal.fitsTarget).toBe(false);
  });

  it("'salmon at lunch': the phrase sets the occasion and leaves the search term", async () => {
    const salmon = eatsHit("s2", "Salmon, Atlantic, cooked", [22, 0, 12]);
    const meal = await composeMeal("u1", { wish: "salmon with rice at lunch", target: TARGET },
      OPEN_PROFILE, portsFor({ salmon: [salmon], rice: [rice] }));
    expect(meal.mealType).toBe("lunch");
    expect(meal.items.map((item) => item.name)).toContain("Salmon, Atlantic, cooked");
  });

  it("'for a late dinner': an explicit phrase with modifiers still names dinner", async () => {
    const meal = await composeMeal("u1", { wish: "chicken and rice for a late dinner", target: TARGET },
      OPEN_PROFILE, portsFor({ chicken: [chicken], rice: [rice] }));
    expect(meal.mealType).toBe("dinner");
    expect(meal.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Chicken breast, roasted", "Rice, white, cooked"]));
  });
});

describe("acceptance 2: an incoherent named combination returns incomplete, never a guess", () => {
  it("tuna with banana: fruit is never on a main plate, even when both are named", async () => {
    const meal = await composeMeal("u1", { wish: "tuna with banana", target: TARGET },
      OPEN_PROFILE, portsFor({ tuna: [tuna], banana: [banana] }));
    expect(meal.incomplete).toBeDefined();
    expect(meal.fitsTarget).toBe(false);
    expect(meal.fitNote).toBeNull();
    // Every named food is kept, none added, none sized as a guess.
    expect(meal.items.map((item) => item.name).sort()).toEqual(["Banana", "Tuna, canned in water"]);
    expect(meal.items.every((item) => item.grams === 0)).toBe(true);
  });

  it("a zero-nutrient named yogurt with added chicken: unknown nutrition is never shown as a number", async () => {
    // With no readable macro at all, `inferFoodRole` has no calorie signal to go on and falls
    // to its carb/starch default (lib/foods/role.ts) — never a protein GUESS for a food the
    // account's own data says nothing about. Paired with chicken (anchor), that reads as the
    // main template's starch side: a coherent plate, so the item is genuinely sized and
    // returned, proving unknown nutrition stays null through a REAL plate, not only inside an
    // incomplete draft where every field is already zeroed.
    const blankYogurt: FoodHit = { foodRefId: REF("y9"), name: "Mystery yogurt", brand: null,
      prefStatus: "eats", kcalPer100g: null, proteinPer100g: null, carbsPer100g: null,
      fatPer100g: null, catalogFoodRevisionId: null, allergenTags: [], category: null };
    const meal = await composeMeal("u1", { wish: "chicken with mystery yogurt", target: TARGET },
      OPEN_PROFILE, portsFor({ chicken: [chicken], mystery: [blankYogurt], yogurt: [blankYogurt] }));
    expect(meal.incomplete).toBeUndefined();
    const yogurtItem = meal.items.find((item) => item.name === "Mystery yogurt");
    expect(yogurtItem).toBeDefined();
    expect(yogurtItem?.kcalPer100g).toBeNull();
    expect(yogurtItem?.proteinPer100g).toBeNull();
    expect(yogurtItem?.carbsPer100g).toBeNull();
    expect(yogurtItem?.fatPer100g).toBeNull();
  });

  it("a blocked named food with no safe alternative: retained and marked, D12's existing swap rule", async () => {
    // D12: "the existing marks and the 'swap a blocked food' rule still apply" — only ONE hit
    // for "shrimp" and it is Avoid-marked, so there is no safe substitute: the food is kept and
    // marked blocked, exactly like the pre-W9 behaviour for a direct composition (unchanged).
    const meal = await composeMeal("u1", { wish: "shrimp with rice", target: TARGET },
      OPEN_PROFILE, portsFor({ shrimp: [avoidedShrimp], rice: [rice] }));
    const shrimpItem = meal.items.find((item) => item.name === "Shrimp");
    expect(shrimpItem).toBeDefined();
    expect(shrimpItem?.verdict).toBe("blocked");
    expect(shrimpItem?.insteadOf).toBeUndefined();
  });

  it("a blocked named food WITH a safe alternative: swapped, not retained (D12's swap rule)", async () => {
    const safeShrimp = eatsHit("sh2", "Shrimp, wild-caught", [24, 0, 0.3]);
    const meal = await composeMeal("u1", { wish: "shrimp with rice", target: TARGET },
      OPEN_PROFILE, portsFor({ shrimp: [avoidedShrimp, safeShrimp], rice: [rice] }));
    const names = meal.items.map((item) => item.name);
    expect(names).not.toContain("Shrimp");
    expect(names).toContain("Shrimp, wild-caught");
    const swapped = meal.items.find((item) => item.name === "Shrimp, wild-caught");
    expect(swapped?.insteadOf).toBe("Shrimp");
    expect(swapped?.verdict).not.toBe("blocked");
  });
});

describe("acceptance 3: a pinned food outside the pool is still searched and still passes policy", () => {
  it("an Avoid-listed named food is kept and marked blocked, never silently dropped", async () => {
    const meal = await composeMeal("u1", { wish: "shrimp with rice", target: TARGET },
      OPEN_PROFILE, portsFor({ shrimp: [avoidedShrimp], rice: [rice] }));
    const shrimpItem = meal.items.find((item) => item.name === "Shrimp");
    expect(shrimpItem).toBeDefined();
    expect(shrimpItem?.verdict).toBe("blocked");
  });

  it("a named food outside the pool still runs the real constraint profile, not just the hit's own mark", async () => {
    // TEST_PROFILE avoids dairy by allergen, not by a per-row Avoid mark: a Favored yogurt row
    // the account never marked Avoid must still come back blocked under the real profile — the
    // policy check a pinned food never skips (D12), proven with the restrictive fixture profile
    // this suite otherwise avoids for the plain coherence cases above.
    const meal = await composeMeal("u1", { wish: "yogurt with oats", target: TARGET },
      TEST_PROFILE, portsFor({ yogurt: [yogurt], oats: [oats] }));
    const yogurtItem = meal.items.find((item) => item.name === "Greek yogurt, plain, nonfat");
    expect(yogurtItem).toBeDefined();
    expect(yogurtItem?.verdict).toBe("blocked");
  });
});

describe("acceptance 4: the four-term cap, and the occasion phrase never counts toward it", () => {
  it("still takes at most four terms, without repeats", () => {
    expect(wishTerms("chicken chicken rice beans avocado salsa onion"))
      .toEqual(["chicken", "rice", "beans", "avocado"]);
  });

  it("an explicit occasion phrase leaves the wish before the term cap, however many words it carries (O4a, W9)", () => {
    // The pipeline composeMeal now runs for a direct wish: strip the phrase FIRST
    // (lib/meals/occasion-phrase.ts), then cap terms on what's left. "For a nice late dinner" is
    // four phrase/modifier words; none of them may cost a food-term slot.
    const phrase = parseOccasionPhrase("salmon rice for a nice late dinner");
    expect(phrase.occasion).toBe("dinner");
    expect(wishTerms(phrase.rest)).toEqual(["salmon", "rice"]);
  });

  it("drives the same pipeline through composeMeal: both named foods still land, occasion is dinner", async () => {
    const salmon = eatsHit("s3", "Salmon, Atlantic, cooked", [22, 0, 12]);
    const meal = await composeMeal("u1",
      { wish: "salmon rice for a nice late dinner", target: TARGET }, OPEN_PROFILE,
      portsFor({ salmon: [salmon], rice: [rice] }));
    expect(meal.mealType).toBe("dinner");
    expect(meal.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Salmon, Atlantic, cooked", "Rice, white, cooked"]));
  });
});

describe("OD26: foods left out are named", () => {
  it("names a food past the four-food cap", async () => {
    const meal = await composeMeal("u1", { wish: "chicken rice apple banana yogurt", target: TARGET },
      OPEN_PROFILE, portsFor({ chicken: [chicken], rice: [rice], apple: [apple], banana: [banana] }));
    expect(meal.leftOut).toEqual([{ term: "yogurt", why: "over_limit" }]);
  });

  it("names a food nothing usable matched, and omits the field when all were used", async () => {
    const missing = await composeMeal("u1", { wish: "chicken with zzzfood", target: TARGET },
      OPEN_PROFILE, portsFor({ chicken: [chicken] }));
    expect(missing.leftOut).toEqual([{ term: "zzzfood", why: "not_found" }]);
    const full = await composeMeal("u1", { wish: "paneer with rice", target: TARGET }, OPEN_PROFILE,
      portsFor({ paneer: [paneer], rice: [rice] }));
    expect(full.leftOut).toBeUndefined();
  });
});
