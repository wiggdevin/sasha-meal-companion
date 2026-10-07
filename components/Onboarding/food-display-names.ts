/**
 * Onboarding v2 lane 4: short disc labels ("Chicken", "Salmon", "Eggs") — orchestrator direction
 * 2026-10-07 after the first screenshot read as "a static catalog with truncated names, not a
 * game." A disc shows this short name; the button's accessible name always carries the FULL food
 * name from `dbFood`, so nothing is lost for assistive tech — only the on-screen label shortens.
 *
 * Keyed by `Starter.id` (`lib/foods/starter.ts`); `foodShortName` falls back to the full name
 * (truncated client-side by the disc's own `line-clamp`) for any id not listed here, so a future
 * starter with no entry still renders, just without a hand-picked short label.
 */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  "chicken-breast-roasted": "Chicken",
  "turkey-breast-roasted": "Turkey",
  "ground-beef-90-10-cooked": "Beef",
  "pork-tenderloin-roasted": "Pork",
  "salmon-wild-sockeye-cooked": "Salmon",
  "tuna-canned-in-water-light": "Tuna",
  "cod-cooked": "Cod",
  "egg-white": "Egg whites",
  "whey-protein-powder": "Whey",
  "egg-whole-large": "Eggs",
  "greek-yogurt-plain-nonfat": "Yogurt",
  "tofu-firm": "Tofu",
  tempeh: "Tempeh",
  "edamame-cooked": "Edamame",
  "lentils-cooked": "Lentils",
  "black-beans-cooked": "Black beans",
  "chickpeas-cooked": "Chickpeas",
  "white-beans-cooked": "White beans",
  "white-rice-cooked": "White rice",
  "brown-rice-cooked": "Brown rice",
  "quinoa-cooked": "Quinoa",
  "oatmeal-cooked": "Oatmeal",
  "potato-baked-with-skin": "Potato",
  "sweet-potato-baked": "Sweet potato",
  banana: "Banana",
  "apple-with-skin": "Apple",
  "white-bread": "White bread",
  "corn-tortilla": "Tortilla",
  "whole-wheat-bread": "Wheat bread",
  blueberries: "Blueberries",
  "broccoli-cooked": "Broccoli",
  "green-beans-cooked": "Green beans",
  "spinach-cooked": "Spinach",
  "olive-oil": "Olive oil",
  "avocado-oil": "Avocado oil",
  avocado: "Avocado",
  "peanut-butter": "Peanut butter",
  almonds: "Almonds",
  "pumpkin-seeds": "Pumpkin seeds",
  butter: "Butter",
};

export function foodShortName(starterId: string, fullName: string): string {
  return SHORT_NAMES[starterId] ?? fullName;
}
