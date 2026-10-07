/**
 * Bundled foods kept out of the universe beyond D1's excluded groups, each with the reason it is
 * not a generic whole or minimally processed food with one SR Legacy identity of its own.
 * Reviewed with the universe (docs/catalog/universe.md). Curated data. No I/O.
 */
export const EXCLUDED: Readonly<Record<string, readonly string[]>> = {
  "cured or processed meat": [
    "turkey-deli-slices", "beef-jerky", "bacon-cooked", "canadian-bacon", "ham-sliced",
    "pork-sausage-cooked", "italian-sausage-cooked", "chorizo", "pepperoni", "salami",
    "hot-dog-beef", "bratwurst", "smoked-salmon",
  ],
  "breaded, fried or formed": [
    "fish-sticks", "crab-cake", "squid-fried", "rotisserie-chicken-breast",
  ],
  "packaged snack or bar": [
    "granola-bar-soft-peanut-butter", "beef-stick", "pork-rinds", "trail-mix", "granola",
    "tortilla-chips", "potato-chips", "pretzels", "saltine-crackers", "graham-crackers",
    "wheat-crackers", "cheese-crackers-goldfish",
  ],
  "fried or prepared potato": [
    "french-fries", "hash-browns", "tater-tots", "sweet-potato-fries", "mashed-potatoes",
  ],
  "prepared dish or baked good": [
    "macaroni-and-cheese", "baked-beans", "overnight-oats", "french-toast", "pancake", "waffle",
    "biscuit", "cornbread", "croissant",
  ],
  "sauce, dressing or spread": [
    "marinara-sauce", "salsa", "tomato-sauce", "tomato-paste", "crushed-tomatoes-canned", "pesto",
    "ranch-dressing", "italian-dressing", "caesar-dressing", "blue-cheese-dressing",
    "light-mayonnaise", "margarine",
  ],
  "sweetened or processed dairy": [
    "chocolate-milk", "american-cheese", "whipped-cream",
  ],
  "pickled, canned mix or baby food": [
    "pickles-dill", "coleslaw", "baby-food-pouch-vegetable", "fruit-cocktail-canned",
    "fruit-salad",
  ],
  "supplement": [
    "whey-protein-powder",
  ],
  "shares an SR row with tomato-raw": [
    "cherry-tomatoes",
  ],
  "raw food that needs cooking (GPT-6 Sol review)": [
    "cassava-raw", "egg-whole-large", "egg-white", "egg-yolk",
  ],
  "flavored, sweetened or dressing product (GPT-6 Sol review)": [
    "ramen-noodles", "coconut-milk-beverage", "mayonnaise", "dried-cranberries",
    "coconut-shredded",
  ],
  "SR row is not one plain identity (GPT-6 Sol review)": [
    "bagel-plain", "vegetable-oil",
  ],
  "branded SR row": [
    "greek-yogurt-plain-nonfat", "soy-milk-unsweetened", "cheerios", "corn-flakes",
    "cream-of-wheat-cooked",
  ],
};
