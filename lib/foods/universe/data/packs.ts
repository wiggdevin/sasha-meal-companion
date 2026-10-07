/**
 * The 12 cuisine packs (Phase 18 D1): for each cuisine, its commonly eaten universe foods, tiered
 * `core` (a defining staple), `common` (an everyday food) or `occasional`. Most are base items with
 * a tier; the rest are the pack staples of ./staples.ts. The tiers are a stated-cuisine signal for
 * ranking (D8); they never admit or exclude a food, which only the account's rules do (D4).
 *
 * Proposed by the builder from the foods each cuisine's everyday dishes use; reviewed per the
 * receipt in docs/catalog/universe/. Curated data. No I/O.
 */
import type { CuisineKey, Tier } from "@/lib/foods/universe/vocabulary";

export const PACKS: Readonly<Record<CuisineKey, Readonly<Record<Tier, readonly string[]>>>> = {
  american: {
    core: [
      "chicken-breast-roasted", "ground-beef-85-15-cooked", "egg-scrambled", "whole-wheat-bread",
      "potato-baked-with-skin", "white-rice-cooked", "broccoli-cooked", "cheddar-cheese",
      "apple-with-skin", "banana", "peanut-butter", "oatmeal-cooked", "turkey-breast-roasted",
      "green-beans-cooked", "corn-on-the-cob", "2-milk",
    ],
    common: [
      "sirloin-steak-broiled", "pork-chop-broiled", "salmon-atlantic-farmed-cooked",
      "tuna-canned-in-water-light", "ground-turkey-cooked", "egg-hard-boiled",
      "greek-yogurt-plain-whole-milk", "cottage-cheese-2", "sweet-potato-baked", "hamburger-bun",
      "english-muffin", "carrot-raw", "romaine-lettuce", "tomato-raw", "strawberries",
      "blueberries", "orange", "grapes", "almonds", "butter", "rolled-oats-dry",
      "spaghetti-cooked", "black-beans-cooked", "pinto-beans-cooked",
    ],
    occasional: [
      "pulled-pork", "brisket-braised", "catfish-cooked", "grits-cooked", "collard-greens-cooked",
      "pecans", "sour-cream", "popcorn-air-popped", "ribeye-steak-grilled", "chicken-wing-roasted",
      "acorn-squash-baked", "cranberries-raw",
    ],
  },
  latin_american: {
    core: [
      "black-beans-cooked", "pinto-beans-cooked", "corn-tortilla", "white-rice-cooked", "avocado",
      "tomato-raw", "onion-raw", "jalape-o", "chicken-thigh-roasted", "egg-scrambled", "lime",
      "cilantro-fresh", "queso-fresco",
    ],
    common: [
      "flour-tortilla", "ground-beef-85-15-cooked", "pork-shoulder-roasted", "skirt-steak-broiled",
      "flank-steak-broiled", "tilapia-cooked", "shrimp-cooked", "bell-pepper-green",
      "bell-pepper-red", "corn-on-the-cob", "plantain-cooked", "mango", "papaya", "sour-cream",
      "refried-beans", "tomatillos-raw", "nopales-cooked", "chayote-cooked", "jicama-raw",
      "hominy-canned", "cabbage-raw", "zucchini-cooked", "sweet-potato-boiled",
    ],
    occasional: [
      "guava", "green-plantain-boiled", "pineapple", "kidney-beans-cooked", "pumpkin-seeds",
      "chicken-breast-roasted", "goat-roasted",
    ],
  },
  italian: {
    core: [
      "spaghetti-cooked", "whole-wheat-pasta-cooked", "tomato-raw", "olive-oil", "garlic",
      "parmesan-cheese", "mozzarella-cheese", "basil-fresh", "zucchini-cooked",
      "chicken-breast-roasted", "white-bread", "ricotta-whole-milk",
    ],
    common: [
      "sourdough-bread", "white-beans-cooked", "chickpeas-cooked", "eggplant-cooked",
      "bell-pepper-red", "spinach-cooked", "arugula", "mushrooms-cooked", "onion-saut-ed",
      "fennel-raw", "artichoke-cooked", "cod-cooked", "shrimp-cooked", "mussels-cooked",
      "clams-cooked", "veal-cutlet-cooked", "sirloin-steak-broiled", "provolone", "olives-black",
      "lemon", "parsley-fresh", "lentils-cooked",
    ],
    occasional: [
      "octopus-cooked", "sardines-canned-in-oil", "anchovies-canned", "swordfish-cooked",
      "farro-spelt-cooked", "pine-nuts", "figs", "peach", "cherries", "goat-cheese",
      "pork-tenderloin-roasted", "leg-of-lamb-roasted", "broccoli-cooked", "cauliflower-cooked",
      "kale-cooked",
    ],
  },
  mediterranean: {
    core: [
      "chickpeas-cooked", "lentils-cooked", "pita-bread", "olive-oil", "tomato-raw", "cucumber",
      "feta-cheese", "greek-yogurt-plain-whole-milk", "hummus", "tahini", "bulgur-cooked", "lemon",
      "parsley-fresh", "eggplant-cooked",
    ],
    common: [
      "couscous-cooked", "leg-of-lamb-roasted", "ground-lamb-cooked", "lamb-chop-broiled",
      "chicken-thigh-roasted", "fava-beans-cooked", "olives-green", "olives-black", "mint-fresh",
      "grape-leaves-raw", "zucchini-cooked", "bell-pepper-red", "onion-raw", "garlic",
      "spinach-cooked", "dates-medjool", "figs", "pomegranate", "pistachios", "almonds", "walnuts",
      "sea-bass-cooked", "yogurt-plain-whole-milk", "white-rice-cooked", "sesame-seeds",
    ],
    occasional: [
      "octopus-cooked", "sardines-canned-in-oil", "goat-roasted", "artichoke-cooked",
      "okra-cooked", "apricot", "dried-apricots", "pine-nuts", "egg-hard-boiled",
      "cauliflower-cooked", "goat-cheese", "swiss-chard-cooked",
    ],
  },
  south_asian: {
    core: [
      "basmati-rice-cooked", "lentils-cooked", "chickpeas-cooked", "chapati-roti", "naan", "ghee",
      "yogurt-plain-whole-milk", "onion-raw", "tomato-raw", "spinach-cooked", "cauliflower-cooked",
      "potato-boiled-peeled", "chicken-thigh-roasted", "pigeon-peas-toor-dal-cooked",
      "mung-beans-moong-dal-cooked",
    ],
    common: [
      "black-gram-urad-dal-cooked", "split-peas-cooked", "kidney-beans-cooked", "peas-cooked",
      "okra-cooked", "eggplant-cooked", "bitter-gourd-cooked", "green-beans-cooked",
      "cabbage-cooked", "carrot-cooked", "cilantro-fresh", "garlic", "egg-hard-boiled",
      "goat-roasted", "ground-lamb-cooked", "leg-of-lamb-roasted", "white-rice-cooked", "mango",
      "banana", "cashews", "almonds", "coconut-milk-canned", "lime", "sweet-potato-boiled",
      "whole-milk",
    ],
    occasional: [
      "shrimp-cooked", "mackerel-cooked", "tilapia-cooked", "pumpkin-cooked", "mint-fresh",
      "papaya", "guava", "dates-medjool", "pistachios", "tamarind", "sesame-seeds",
      "brown-rice-cooked", "millet-cooked",
    ],
  },
  chinese: {
    core: [
      "white-rice-cooked", "jasmine-rice-cooked", "tofu-firm", "bok-choy-cooked", "egg-scrambled",
      "pork-shoulder-roasted", "chicken-thigh-roasted", "napa-cabbage-cooked", "green-onion",
      "garlic", "rice-noodles-cooked", "egg-noodles-cooked", "sesame-oil",
      "shiitake-mushrooms-cooked",
    ],
    common: [
      "chinese-broccoli-gai-lan-cooked", "snow-peas-cooked", "mung-bean-sprouts-raw",
      "bamboo-shoots-canned", "water-chestnuts-raw", "broccoli-cooked", "eggplant-cooked",
      "bell-pepper-green", "carrot-cooked", "shrimp-cooked", "flank-steak-broiled",
      "duck-breast-roasted", "sea-bass-cooked", "peanuts", "cashews", "edamame-cooked", "cucumber",
      "spinach-cooked", "celery-raw", "mushrooms-cooked", "lotus-root-cooked",
      "adzuki-beans-cooked", "daikon-cooked",
    ],
    occasional: [
      "asian-pear", "lychee", "orange", "pork-ribs-roasted", "scallops-raw", "clams-cooked",
      "bitter-gourd-cooked", "yardlong-beans-cooked", "brown-rice-cooked", "millet-cooked",
    ],
  },
  japanese: {
    core: [
      "sushi-rice-cooked", "white-rice-cooked", "salmon-atlantic-farmed-cooked",
      "tuna-yellowfin-cooked", "tofu-firm", "edamame-cooked", "seaweed-nori", "wakame-seaweed",
      "egg-scrambled", "soba-noodles-cooked", "green-onion", "daikon-cooked", "natto",
      "shiitake-mushrooms-cooked",
    ],
    common: [
      "mackerel-cooked", "cod-cooked", "shrimp-cooked", "chicken-thigh-roasted",
      "sirloin-steak-broiled", "spinach-cooked", "napa-cabbage-cooked", "cabbage-raw", "cucumber",
      "carrot-cooked", "sweet-potato-baked", "lotus-root-cooked", "bamboo-shoots-canned",
      "adzuki-beans-cooked", "sesame-seeds", "mushrooms-cooked", "asian-pear", "egg-hard-boiled",
      "scallops-raw", "octopus-cooked",
    ],
    occasional: [
      "clams-cooked", "mung-bean-sprouts-raw", "snow-peas-cooked", "eggplant-cooked", "clementine",
      "green-beans-cooked", "brown-rice-cooked", "pumpkin-cooked", "pork-chop-broiled",
    ],
  },
  korean: {
    core: [
      "white-rice-cooked", "kimchi", "tofu-firm", "egg-scrambled", "sesame-oil", "green-onion",
      "garlic", "napa-cabbage-cooked", "soybean-sprouts-cooked", "flank-steak-broiled",
      "pork-shoulder-roasted", "seaweed-nori", "spinach-cooked",
    ],
    common: [
      "chicken-thigh-roasted", "beef-short-ribs-braised", "mackerel-cooked", "anchovies-canned",
      "mung-bean-sprouts-raw", "daikon-cooked", "zucchini-cooked", "cucumber", "carrot-cooked",
      "shiitake-mushrooms-cooked", "sweet-potato-baked", "sesame-seeds", "wakame-seaweed",
      "egg-hard-boiled", "asian-pear", "adzuki-beans-cooked", "brown-rice-cooked",
      "octopus-cooked", "clams-cooked",
    ],
    occasional: [
      "shrimp-cooked", "mussels-cooked", "pork-ribs-roasted", "lotus-root-cooked",
      "bell-pepper-green", "soba-noodles-cooked", "barley-cooked", "millet-cooked", "clementine",
      "apple-with-skin",
    ],
  },
  southeast_asian: {
    core: [
      "jasmine-rice-cooked", "rice-noodles-cooked", "tofu-firm", "shrimp-cooked",
      "chicken-thigh-roasted", "coconut-milk-canned", "lime", "lemongrass", "cilantro-fresh",
      "mung-bean-sprouts-raw", "egg-fried", "peanuts", "cucumber", "bok-choy-cooked",
    ],
    common: [
      "pork-shoulder-roasted", "flank-steak-broiled", "tilapia-cooked", "catfish-cooked",
      "mussels-cooked", "tempeh", "yardlong-beans-cooked", "eggplant-cooked", "bell-pepper-red",
      "garlic", "green-onion", "carrot-raw", "cabbage-raw", "napa-cabbage-cooked",
      "spinach-cooked", "mango", "papaya", "pineapple", "banana", "jackfruit-raw", "lychee",
      "tamarind", "basil-fresh", "mint-fresh", "sweet-potato-boiled", "white-rice-cooked",
      "cashews",
    ],
    occasional: [
      "duck-breast-roasted", "crab-cooked", "clams-cooked", "octopus-cooked",
      "bamboo-shoots-canned", "bitter-gourd-cooked", "okra-cooked", "taro-cooked", "guava",
      "watermelon", "mackerel-cooked", "egg-hard-boiled",
    ],
  },
  caribbean: {
    core: [
      "white-rice-cooked", "kidney-beans-cooked", "black-beans-cooked",
      "pigeon-peas-toor-dal-cooked", "chicken-thigh-roasted", "green-plantain-boiled",
      "plantain-cooked", "yam-cooked", "callaloo-amaranth-leaves-cooked", "coconut-milk-canned",
      "lime", "onion-raw", "bell-pepper-green",
    ],
    common: [
      "goat-roasted", "pork-shoulder-roasted", "ground-beef-85-15-cooked", "cod-cooked",
      "sea-bass-cooked", "shrimp-cooked", "mackerel-cooked", "black-eyed-peas-cooked",
      "breadfruit", "sweet-potato-boiled", "pumpkin-cooked", "taro-cooked", "okra-cooked",
      "cabbage-cooked", "carrot-cooked", "tomato-raw", "garlic", "green-onion", "chayote-cooked",
      "mango", "papaya", "pineapple", "banana", "guava", "avocado", "egg-scrambled",
    ],
    occasional: [
      "tamarind", "jackfruit-raw", "lobster-cooked", "crab-cooked", "sardines-canned-in-oil",
      "brown-rice-cooked", "watercress-raw", "peanuts", "collard-greens-cooked",
      "sweet-potato-leaves-cooked",
    ],
  },
  african: {
    core: [
      "millet-cooked", "teff-cooked", "yam-cooked", "green-plantain-boiled",
      "black-eyed-peas-cooked", "peanuts", "peanut-butter", "okra-cooked", "tomato-raw",
      "onion-raw", "chicken-thigh-roasted", "goat-roasted", "white-rice-cooked",
      "collard-greens-cooked",
    ],
    common: [
      "lentils-cooked", "chickpeas-cooked", "fava-beans-cooked", "kidney-beans-cooked",
      "sweet-potato-leaves-cooked", "callaloo-amaranth-leaves-cooked", "spinach-cooked",
      "cabbage-cooked", "carrot-cooked", "sweet-potato-boiled", "pumpkin-cooked",
      "eggplant-cooked", "bell-pepper-red", "garlic", "plantain-cooked",
      "ground-beef-85-15-cooked", "leg-of-lamb-roasted", "tilapia-cooked", "mackerel-cooked",
      "sardines-canned-in-oil", "egg-hard-boiled", "mango", "banana", "papaya", "avocado",
      "couscous-cooked", "taro-cooked", "coconut-milk-canned", "sesame-seeds", "dates-medjool",
    ],
    occasional: [
      "pigeon-peas-toor-dal-cooked", "mung-beans-moong-dal-cooked", "cashews", "shrimp-cooked",
      "catfish-cooked", "guava", "pineapple", "watermelon", "yogurt-plain-whole-milk",
      "breadfruit", "chapati-roti", "split-peas-cooked",
    ],
  },
  european_other: {
    core: [
      "potato-boiled-peeled", "rye-bread", "cabbage-cooked", "sauerkraut", "pork-shoulder-roasted",
      "chicken-breast-roasted", "egg-hard-boiled", "butter", "carrot-cooked", "onion-saut-ed",
      "beets-cooked", "apple-with-skin", "whole-milk", "swiss-cheese",
      "buckwheat-groats-kasha-cooked",
    ],
    common: [
      "red-cabbage-cooked", "leeks-cooked", "turnips-cooked", "rutabaga-cooked", "kohlrabi-cooked",
      "celeriac-cooked", "parsnips-cooked", "brussels-sprouts-cooked", "cauliflower-cooked",
      "green-beans-cooked", "peas-cooked", "mushrooms-cooked", "cucumber", "sour-cream",
      "cottage-cheese-2", "gouda-cheese", "herring-cooked", "cod-cooked", "trout-cooked",
      "salmon-atlantic-farmed-cooked", "pork-tenderloin-roasted", "chuck-roast-braised",
      "veal-cutlet-cooked", "duck-breast-roasted", "egg-noodles-cooked", "barley-cooked",
      "sourdough-bread", "pear", "plum", "cherries", "raspberries", "blackberries", "walnuts",
      "hazelnuts", "lard", "sunflower-seeds",
    ],
    occasional: [
      "watercress-raw", "dandelion-greens-cooked", "mackerel-cooked", "lentils-cooked",
      "split-peas-cooked", "brie", "blue-cheese", "goat-cheese", "oatmeal-cooked",
    ],
  },
};
