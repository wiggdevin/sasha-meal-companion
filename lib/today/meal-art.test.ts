import { describe, expect, it } from "vitest";
import { illustrativeMealImage, mealArtAspect } from "@/lib/today/meal-art";

/** `illustrativeMealImage` takes a name and an ingredient list; these helpers cover both call shapes
 *  the app actually uses — a bare name (no logged items) and a name plus real food-catalog items. */
function byName(name: string) {
  return illustrativeMealImage(name, []);
}
function byItems(name: string, ...items: string[]) {
  return illustrativeMealImage(name, items.map((n) => ({ name: n })));
}

describe("illustrativeMealImage — original five, unchanged", () => {
  it("scallops", () => expect(byName("Seared scallops")).toBe("/meal-art/scallops.webp"));
  it("eggs + rice", () => expect(byItems("Breakfast", "Eggs ×4", "White rice, cooked")).toBe("/meal-art/eggs-rice.webp"));
  it("chicken", () => expect(byName("Chicken breast, roasted")).toBe("/meal-art/chicken.webp"));
  it("chicken wins over a dish shape also present (rice bowls)", () =>
    expect(byName("Lemon chicken, rice and broccoli")).toBe("/meal-art/chicken.webp"));
  it("shake / smoothie / whey", () => {
    expect(byName("Protein shake")).toBe("/meal-art/shake.webp");
    expect(byName("Berry smoothie")).toBe("/meal-art/shake.webp");
    expect(byItems("Snack", "Whey protein powder")).toBe("/meal-art/shake.webp");
  });
  it("yogurt + berries", () => expect(byItems("Snack", "Greek yogurt, plain nonfat", "Strawberries")).toBe("/meal-art/yogurt.webp"));
});

describe("illustrativeMealImage — proteins", () => {
  it("salmon", () => {
    expect(byName("Salmon, Atlantic farmed, cooked")).toBe("/meal-art/salmon.webp");
    expect(byName("Smoked salmon")).toBe("/meal-art/salmon.webp");
  });
  it("tuna", () => {
    expect(byName("Ahi tuna")).toBe("/meal-art/tuna.webp");
    expect(byName("Tuna, canned in water, light")).toBe("/meal-art/tuna.webp");
  });
  it("shrimp", () => expect(byName("Shrimp, cooked")).toBe("/meal-art/shrimp.webp"));
  it("white fish", () => {
    expect(byName("Pan-seared cod")).toBe("/meal-art/white-fish.webp");
    expect(byName("Grilled halibut")).toBe("/meal-art/white-fish.webp");
  });
  it("turkey", () => expect(byName("Turkey breast, roasted")).toBe("/meal-art/turkey.webp"));
  it("pork", () => {
    expect(byName("Pork tenderloin, roasted")).toBe("/meal-art/pork.webp");
    expect(byName("Bacon, cooked")).toBe("/meal-art/pork.webp");
    expect(byName("Prosciutto")).toBe("/meal-art/pork.webp");
  });
  it("beef / steak", () => {
    expect(byName("Sirloin steak, broiled")).toBe("/meal-art/beef-steak.webp");
    expect(byName("Sirloin steak with roast carrots and quinoa")).toBe("/meal-art/beef-steak.webp");
    expect(byName("Ribeye steak, grilled")).toBe("/meal-art/beef-steak.webp");
  });
  it("ground beef", () => {
    expect(byName("Ground beef 90/10, cooked")).toBe("/meal-art/ground-beef.webp");
    expect(byName("Burger with fries")).toBe("/meal-art/ground-beef.webp");
  });
  it("tofu", () => expect(byName("Tofu, firm")).toBe("/meal-art/tofu.webp"));
  it("eggs (no rice)", () => {
    expect(byName("Easy egg and spinach breakfast plates")).toBe("/meal-art/eggs.webp");
    expect(byName("Veggie omelet")).toBe("/meal-art/eggs.webp");
  });
});

describe("illustrativeMealImage — dish shapes", () => {
  it("oats / porridge", () => {
    expect(byName("Oatmeal, cooked")).toBe("/meal-art/oats-porridge.webp");
    expect(byName("Banana yogurt overnight oats")).toBe("/meal-art/oats-porridge.webp");
  });
  it("pancakes / waffles", () => expect(byName("Pancake")).toBe("/meal-art/pancakes.webp"));
  it("avocado toast", () => expect(byName("Avocado toast on sourdough")).toBe("/meal-art/toast-avocado.webp"));
  it("sandwich / wrap", () => {
    expect(byName("BLT sandwich")).toBe("/meal-art/sandwich-wrap.webp");
    expect(byName("Turkey wrap")).toBe("/meal-art/sandwich-wrap.webp");
  });
  it("tacos / burrito", () => {
    expect(byName("Taco, beef")).toBe("/meal-art/tacos-burrito.webp");
    expect(byName("Burrito, bean and cheese")).toBe("/meal-art/tacos-burrito.webp");
  });
  it("pasta", () => {
    expect(byName("Whole wheat pasta, cooked")).toBe("/meal-art/pasta.webp");
    expect(byName("Tomato and red pepper pasta")).toBe("/meal-art/pasta.webp");
  });
  it("a rice bowl without chicken gets the olive art (the rice bowl photo is chicken on rice)", () => {
    expect(byName("Black bean and pepper rice bowls")).toBeNull();
    expect(byName("Fried rice")).toBeNull();
  });
  it("stir-fry", () => expect(byName("Beef and broccoli stir-fry")).toBe("/meal-art/stir-fry.webp"));
  it("salad", () => expect(byName("Fruit salad")).toBe("/meal-art/salad.webp"));
  it("soup / stew", () => {
    expect(byName("Lentil, carrot and tomato stew")).toBe("/meal-art/soup-stew.webp");
    expect(byName("Vegetable soup")).toBe("/meal-art/soup-stew.webp");
  });
  it("curry", () => expect(byName("Chickpea curry")).toBe("/meal-art/curry.webp"));
  it("sushi / poke", () => {
    expect(byName("Salmon poke bowl")).toBe("/meal-art/sushi-poke.webp");
    expect(byName("Tuna sushi")).toBe("/meal-art/sushi-poke.webp");
  });
  it("pizza", () => expect(byName("Pizza, pepperoni")).toBe("/meal-art/pizza.webp"));
});

describe("illustrativeMealImage — dairy, snacks and sides", () => {
  it("yogurt without berries", () => expect(byName("Frozen yogurt")).toBe("/meal-art/yogurt-fruit.webp"));
  it("protein bar / snack plate", () => expect(byName("Protein bar")).toBe("/meal-art/protein-bar-snack.webp"));
  it("nuts / dried fruit", () => {
    expect(byName("Mixed nuts")).toBe("/meal-art/nuts-fruit-snack.webp");
    expect(byName("Walnuts")).toBe("/meal-art/nuts-fruit-snack.webp");
  });
  it("cottage cheese without berries", () => expect(byName("Cottage cheese, 2%")).toBe("/meal-art/cottage-cheese.webp"));
  it("potatoes / sweet potato", () => {
    expect(byName("Sweet potato, baked")).toBe("/meal-art/potatoes-sweet-potato.webp");
    expect(byName("Mashed potatoes")).toBe("/meal-art/potatoes-sweet-potato.webp");
  });
});

describe("illustrativeMealImage — fallback and no-meal gradient", () => {
  it("gives a real meal no photo fits the olive art, never the chicken plate", () => {
    expect(byName("Chef's choice")).toBeNull();
    expect(byName("Dumplings")).toBeNull();
  });
  it("keeps the gradient placeholder only when there is no meal at all", () => {
    expect(illustrativeMealImage("", [])).toBeNull();
    expect(illustrativeMealImage("   ", [])).toBeNull();
  });
});

describe("mealArtAspect", () => {
  it("keeps the four original stock photos' own aspect ratios", () => {
    expect(mealArtAspect("/meal-art/scallops.webp")).toBeCloseTo(1100 / 1650);
    expect(mealArtAspect("/meal-art/chicken.webp")).toBeCloseTo(1100 / 733);
    expect(mealArtAspect("/meal-art/shake.webp")).toBeCloseTo(1100 / 733);
    expect(mealArtAspect("/meal-art/yogurt.webp")).toBeCloseTo(600 / 900);
  });
  it("gives every generated photo the shared 1100x1467 portrait frame", () => {
    expect(mealArtAspect("/meal-art/salmon.webp")).toBeCloseTo(1100 / 1467);
    expect(mealArtAspect("/meal-art/balanced-plate.webp")).toBeCloseTo(1100 / 1467);
  });
});

describe("illustrativeMealImage — rice is a side", () => {
  it("photographs the named protein, not a rice bowl", () => {
    expect(byName("Ahi tuna, cooked with White rice, cooked")).toBe("/meal-art/tuna.webp");
    expect(byName("Salmon with brown rice")).toBe("/meal-art/salmon.webp");
  });
  it("never pictures chicken for rice beside another protein, or alone", () => {
    expect(byName("Vegetable rice")).toBeNull();
  });
});

describe("illustrativeMealImage — the photo's protein is the meal's (Kimi K10, 2026-10-04)", () => {
  it("canned albacore with rice is tuna", () =>
    expect(byItems("Meal 4", "Canned albacore, drained", "White rice, cooked")).toBe("/meal-art/tuna.webp"));
  it("deer with rice has no photo of its own, so the olive art", () =>
    expect(byItems("Meal 2", "Game meat, deer, cooked", "Jasmine rice, cooked")).toBeNull());
  it("chicken with rice is the chicken photo", () =>
    expect(byItems("Meal 1", "Chicken breast, roasted", "White rice, cooked")).toBe("/meal-art/chicken.webp"));
  it("three different meals never share one photo", () => {
    const shown = [byItems("A", "Canned albacore, drained", "White rice"), byItems("B", "Game meat, deer", "White rice"),
      byItems("C", "Chicken breast", "White rice")];
    expect(shown.filter(Boolean)).toEqual([...new Set(shown.filter(Boolean))]);
  });
});
