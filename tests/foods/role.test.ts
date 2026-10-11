import { describe, expect, it } from "vitest";
import { inferFoodRole, judgeFoodRole, roleFromCalories, roleFromName } from "@/lib/foods/role";
import { foodsFromSyncRows } from "@/lib/store";

/** Per 100 g, as user_foods.per_100g stores them. */
const NONE = { protein: 0, carbs: 0, fat: 0 };

describe("a food's macro group", () => {
  it("puts meat, poultry, fish and eggs under Protein, soups and mixed dishes included", () => {
    // The owner's report (2026-10-04): "Soup, beef" showed the carbs dot.
    expect(inferFoodRole("Soup, beef", { protein: 3.3, carbs: 4, fat: 2.1 })).toBe("protein");
    expect(inferFoodRole("Game meat, deer, raw", { protein: 23, carbs: 0, fat: 2.4 })).toBe("protein");
    expect(inferFoodRole("Beef jerky", { protein: 33.2, carbs: 11, fat: 25.6 })).toBe("protein");
    expect(inferFoodRole("Eggs, large", { protein: 12.6, carbs: 0.8, fat: 10 })).toBe("protein");
    expect(inferFoodRole("Chicken noodle soup", { protein: 3, carbs: 7, fat: 1 })).toBe("protein");
    expect(inferFoodRole("Tuna, canned in oil", { protein: 29, carbs: 0, fat: 8 })).toBe("protein");
    expect(inferFoodRole("Canned albacore, drained", NONE)).toBe("protein");
  });

  it("puts oils, nuts, seeds, nut butters and avocado under Fats", () => {
    for (const name of ["Olive oil", "Fat, beef tallow", "Almond butter", "Pumpkin seeds", "Avocado",
      "Peanut butter", "Walnuts", "Avocado mayo", "Chicken fat"]) {
      expect(roleFromName(name), name).toBe("fat");
    }
  });

  it("puts fruit, grains, starches and sweeteners under Carbs", () => {
    for (const name of ["Banana, medium", "Melon (cantaloupe)", "Jasmine rice, cooked", "Honey",
      "Maple syrup", "Butternut squash, roasted", "Sweet potato, baked", "Egg noodles", "Oatmeal, cooked"]) {
      expect(roleFromName(name), name).toBe("carb");
    }
  });

  it("does not read a fat or protein word inside another word or a descriptor", () => {
    expect(roleFromName("Butternut squash")).toBe("carb");
    expect(roleFromName("Buttermilk, reduced fat")).toBeNull();
    expect(roleFromName("Butter beans")).toBeNull();
    expect(roleFromName("Fish sauce")).toBeNull();
    expect(roleFromName("Hamburger bun")).toBe("carb");
  });

  // 2026-10-04 audit (MAJOR 6): pinned before a production --fix. "crab apple" read as crab.
  it("does not read a protein word that names a fruit, mushroom, sauce, candy or drink", () => {
    expect(roleFromName("Crab apple")).toBe("carb");
    expect(roleFromName("Crabapples, raw")).toBe("carb");
    expect(roleFromName("Crab, blue, cooked")).toBe("protein");
    expect(roleFromName("Imitation crab")).toBe("protein");
    expect(roleFromName("Oyster mushrooms")).toBeNull();
    expect(roleFromName("Oysters, raw")).toBe("protein");
    expect(roleFromName("Chicken of the woods")).toBeNull();
    expect(roleFromName("Buffalo sauce")).toBeNull();
    expect(roleFromName("Steak sauce")).toBeNull();
    expect(roleFromName("Swedish fish")).toBeNull();
    expect(roleFromName("Egg nog")).toBeNull();
    // The phrase is ignored, not the whole name: a real protein beside it still counts.
    expect(roleFromName("Chicken with fish sauce")).toBe("protein");
    expect(roleFromName("Chicken and egg noodles")).toBe("protein");
    expect(roleFromName("Egg noodles")).toBe("carb");
  });

  // 2026-10-04 re-audit (MAJOR 3): goat/buffalo dairy is not meat, and a nut or coconut made into
  // a milk, sugar or water is not a fat by name. The calories decide those.
  it("reads goat and buffalo dairy as dairy, decided by calories", () => {
    for (const name of ["Goat cheese", "Goat's cheese, soft", "Cheese, goat, hard type", "Buffalo mozzarella",
      "Milk, goat, fluid", "Goat milk", "Buffalo milk", "Goat yogurt"]) {
      expect(roleFromName(name), name).toBeNull();
    }
    expect(judgeFoodRole("Goat cheese", { protein: 21.6, carbs: 0.1, fat: 29.8 }))
      .toEqual({ role: "fat", source: "calories" });
    expect(judgeFoodRole("Buffalo mozzarella", { protein: 17, carbs: 0.5, fat: 24 }))
      .toEqual({ role: "fat", source: "calories" });
    expect(inferFoodRole("Milk, goat, fluid", { protein: 3.6, carbs: 4.5, fat: 4.1 })).toBe("fat");
    // The meat is still protein, and a real protein beside the cheese still counts.
    expect(roleFromName("Goat, cooked")).toBe("protein");
    expect(roleFromName("Buffalo wings")).toBe("protein");
    expect(roleFromName("Chicken with goat cheese")).toBe("protein");
    expect(roleFromName("Cottage cheese")).toBe("protein");
  });

  it("does not read a nut or coconut milk, sugar, flour or water as a fat by name", () => {
    for (const name of ["Almond milk", "Almond milk, unsweetened", "Milk, cashew", "Coconut milk",
      "Coconut sugar", "Coconut water", "Beverages, almond milk", "Coconut aminos", "Oat milk"]) {
      expect(roleFromName(name) === "fat", name).toBe(false);
    }
    expect(judgeFoodRole("Coconut sugar", { protein: 1, carbs: 92, fat: 0.5 }))
      .toEqual({ role: "carb", source: "calories" });
    expect(judgeFoodRole("Coconut water", { protein: 0.7, carbs: 3.7, fat: 0.2 }))
      .toEqual({ role: "carb", source: "calories" });
    expect(judgeFoodRole("Almond milk, sweetened", { protein: 0.4, carbs: 6.6, fat: 1 }))
      .toEqual({ role: "carb", source: "calories" });
    expect(judgeFoodRole("Coconut milk, canned", { protein: 2.3, carbs: 5.5, fat: 24 }))
      .toEqual({ role: "fat", source: "calories" });
    // Plain nuts, nut butters and coconut cream stay fat by name.
    for (const name of ["Almonds", "Almond butter", "Coconut cream", "Coconut, shredded", "Cashews",
      "Nut butter with maple syrup"]) {
      expect(roleFromName(name), name).toBe("fat");
    }
  });

  it("decides an unnamed dish by the macro that brings the most calories, not the most grams", () => {
    // 4 g carbs (16 kcal) against 3 g fat (27 kcal): grams said carbs, calories say fat.
    expect(roleFromCalories({ protein: 1, carbs: 4, fat: 3 })).toBe("fat");
    expect(judgeFoodRole("Soup, vegetable", { protein: 1.5, carbs: 6, fat: 0.5 }))
      .toEqual({ role: "carb", source: "calories" });
    expect(judgeFoodRole("Mystery stew", NONE)).toBeNull();
    expect(inferFoodRole("Mystery stew", NONE, "fat")).toBe("fat");
  });
});

describe("the phone projection's role for a food with no stored role", () => {
  const row = (id: string, name: string, per100: Record<string, number>) =>
    ({ id, name, per_100g: per100, deleted_at: null });
  const pref = (ref: string) => ({ food_ref_id: ref, status: "eats", role: null });
  const ref = (id: string, food: string) => ({ id, user_food_id: food });

  it("uses the name and calorie rule instead of a blanket Carbs", () => {
    const foods = foodsFromSyncRows(
      [row("soup", "Soup, beef", { protein: 3.3, carbohydrate: 4, fat_total: 2.1 }),
        row("oil", "Ghee", { fat_total: 99 })],
      [pref("r-soup"), pref("r-oil")],
      [ref("r-soup", "soup"), ref("r-oil", "oil")],
    );
    expect(foods.soup.role).toBe("protein");
    expect(foods.oil.role).toBe("fat");
  });

  it("keeps a stored role: the account's own choice wins", () => {
    const foods = foodsFromSyncRows(
      [row("soup", "Soup, beef", { protein: 3.3, carbohydrate: 4, fat_total: 2.1 })],
      [{ food_ref_id: "r-soup", status: "eats", role: "carb" }],
      [ref("r-soup", "soup")],
    );
    expect(foods.soup.role).toBe("carb");
  });
});

// Audit 2026-10-10 A042 (W029): cured and processed meats and offal fell through to the calorie
// rule and, being fat-heavy, read as fat.
describe("cured, processed and organ meats", () => {
  const FATTY = { protein: 12, carbs: 1, fat: 40 };

  it("are protein by name, whatever the calories say", () => {
    for (const name of ["Bacon", "Bacon, cooked", "Pork sausage", "Sausages, breakfast", "Pepperoni",
      "Salami", "Chorizo", "Hot dog", "Hot dogs, beef", "Frankfurter", "Bratwurst", "Kielbasa",
      "Liver, chicken", "Liver", "Beef kidney", "Pastrami", "Bologna", "Pancetta", "Prosciutto",
      "Liverwurst", "Andouille sausage", "Mortadella", "Turkey bacon"]) {
      expect(judgeFoodRole(name, FATTY), name).toEqual({ role: "protein", source: "name" });
    }
  });

  it("keeps the pure fats, a bun and kidney beans out of it", () => {
    expect(roleFromName("Bacon fat")).toBe("fat");
    expect(roleFromName("Bacon grease")).toBe("fat");
    expect(roleFromName("Cod liver oil")).toBe("fat");
    expect(roleFromName("Hot dog bun")).toBe("carb");
    expect(roleFromName("Kidney beans")).toBeNull();
  });
});
