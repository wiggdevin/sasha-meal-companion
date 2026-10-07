/**
 * The universe's cuisine-pack staples (Phase 18 D1): commonly eaten foods of the 12 cuisine packs
 * that the base layer does not carry. Each was added to the curated list in
 * scripts/build-food-db.py (UNIVERSE_STAPLES) and lib/food-db.json regenerated from the local USDA
 * SR Legacy backup. A staple enters a cuisine's pool only through its pack (./packs.ts).
 *
 * Seeds as in ./base.ts. Curated data. No I/O.
 */
import { seed, type UniverseSeed } from "@/lib/foods/universe/seed";

export const STAPLE_SEEDS: readonly UniverseSeed[] = [
  // Vegetables
  seed("jicama-raw", 170073, ["crunchy"]),
  seed("chayote-cooked", 170403),
  seed("nopales-cooked", 169388, ["slimy"]),
  seed("tomatillos-raw", 168566, ["sour"]),
  seed("cilantro-fresh", 169997, ["pungent"], false),
  // Dairy
  seed("queso-fresco", 172223),
  // Grains, breads, starches and legumes
  seed("hominy-canned", 169701),
  // Fruit
  seed("guava", 173044),
  // Vegetables
  seed("fennel-raw", 169385, ["crunchy"]),
  seed("basil-fresh", 172232, [], false),
  seed("parsley-fresh", 170416, [], false),
  seed("mint-fresh", 173475, [], false),
  seed("grape-leaves-raw", 168575),
  // Grains, breads, starches and legumes
  seed("fava-beans-cooked", 173753),
  // Meat, poultry, fish, eggs and soy
  seed("octopus-cooked", 174249, ["chewy"]),
  // Grains, breads, starches and legumes
  seed("pigeon-peas-toor-dal-cooked", 172437),
  seed("mung-beans-moong-dal-cooked", 174257),
  seed("black-gram-urad-dal-cooked", 172427),
  seed("split-peas-cooked", 172429),
  // Vegetables
  seed("okra-cooked", 169261, ["slimy"]),
  seed("bitter-gourd-cooked", 168394, ["bitter"]),
  // Grains, breads, starches and legumes
  seed("chapati-roti", 171844),
  // Meat, poultry, fish, eggs and soy
  seed("goat-roasted", 175304, ["gamey"]),
  // Vegetables
  seed("napa-cabbage-cooked", 169980),
  seed("snow-peas-cooked", 170011),
  seed("mung-bean-sprouts-raw", 169957, ["crunchy"]),
  seed("shiitake-mushrooms-cooked", 168437),
  seed("chinese-broccoli-gai-lan-cooked", 169392),
  seed("bamboo-shoots-canned", 169212),
  seed("water-chestnuts-raw", 170066, ["crunchy"]),
  seed("lotus-root-cooked", 168430),
  // Grains, breads, starches and legumes
  seed("adzuki-beans-cooked", 173728),
  seed("soba-noodles-cooked", 168907),
  // Vegetables
  seed("wakame-seaweed", 170496),
  seed("daikon-cooked", 168452),
  // Meat, poultry, fish, eggs and soy
  seed("natto", 172443, ["slimy", "pungent"]),
  // Vegetables
  seed("soybean-sprouts-cooked", 168460),
  // Fruit
  seed("asian-pear", 168177, ["crunchy"]),
  seed("jackfruit-raw", 174687),
  seed("lychee", 169086),
  seed("tamarind", 167763, ["sour"]),
  // Vegetables
  seed("lemongrass", 168573, [], false),
  seed("yardlong-beans-cooked", 169223),
  // Grains, breads, starches and legumes
  seed("yam-cooked", 170072),
  seed("breadfruit", 171714),
  seed("green-plantain-boiled", 168216),
  // Vegetables
  seed("callaloo-amaranth-leaves-cooked", 169202),
  // Grains, breads, starches and legumes
  seed("black-eyed-peas-cooked", 173759),
  // Vegetables
  seed("pumpkin-cooked", 168449),
  // Grains, breads, starches and legumes
  seed("teff-cooked", 168918),
  seed("millet-cooked", 168871),
  // Vegetables
  seed("sweet-potato-leaves-cooked", 169304),
  // Grains, breads, starches and legumes
  seed("buckwheat-groats-kasha-cooked", 170686),
  // Vegetables
  seed("turnips-cooked", 170058),
  seed("rutabaga-cooked", 168455),
  seed("kohlrabi-cooked", 168425),
  seed("celeriac-cooked", 169987),
  seed("leeks-cooked", 168426),
  seed("red-cabbage-cooked", 169978),
  // Dairy
  seed("gouda-cheese", 171241),
  // Meat, poultry, fish, eggs and soy
  seed("herring-cooked", 175117, ["strong_fish"]),
  // Vegetables
  seed("watercress-raw", 170068, ["bitter"]),
  seed("dandelion-greens-cooked", 169227, ["bitter"]),
];
