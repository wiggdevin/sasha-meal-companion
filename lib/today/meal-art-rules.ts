/**
 * The ordered photo rules `illustrativeMealImage` (meal-art.ts) checks against a meal's lowercased
 * name + ingredient words. First match wins, so the most specific dish or protein goes first and the
 * broadest catch-alls go last. Kept separate from meal-art.ts to hold the module's 400-line cap.
 *
 * The first five rules are the original stock-photo picks (scallops, eggs+rice, chicken, shake,
 * yogurt+berries) — unchanged and left first so every meal that used to match one of them still does.
 * Everything after extends coverage to the ~30 real dish/protein categories in the account's food
 * catalog (lib/meals.ts, lib/food-db.json, lib/recipe-catalog/pilot.ts) so nearly every meal card gets
 * a photo. A photo that shows a protein (`shows`) is used only for a meal whose one named protein it
 * is; a meal nothing here fits gets the app's own olive art (null), never a stranger's photo.
 */

/**
 * The protein a photo shows, when it shows one. A photo that pictures a protein is only used for a
 * meal that names that protein and no other (owner and Kimi audit 2026-10-04: canned albacore with
 * rice and deer with rice both showed the chicken rice bowl, because rice alone matched it). A photo
 * with no `shows` pictures a kind of dish, whatever is in it.
 */
export type Protein = "chicken" | "beef" | "pork" | "turkey" | "salmon" | "tuna" | "white fish"
  | "shellfish" | "egg" | "tofu" | "game" | "lamb" | "duck";

export type MealArtRule = { match: (words: string) => boolean; image: string; shows?: Protein };

function word(...terms: string[]): RegExp {
  return new RegExp(`\\b(${terms.join("|")})\\b`);
}

export const BALANCED_PLATE_IMAGE = "/meal-art/balanced-plate.webp";

/** The words that name each protein. Kept broad so a meal's protein is never mistaken for none:
 *  game and lamb have no photo of their own, and so get the olive art rather than a chicken plate. */
const PROTEIN_WORDS: Record<Protein, RegExp> = {
  chicken: word("chicken"),
  beef: /ground beef|\b(beef|steak|sirloin|ribeye|brisket|burgers?|meatballs?|bolognese|veal)\b/,
  pork: word("pork", "bacon", "ham", "sausages?", "prosciutto", "chorizo", "pepperoni", "salami"),
  turkey: word("turkey"),
  salmon: word("salmon"),
  tuna: word("tuna", "ahi", "albacore", "skipjack", "yellowfin"),
  "white fish": word("cod", "halibut", "tilapia", "snapper", "mahi", "sea bass", "trout", "white fish", "fish",
    "haddock", "pollock", "sardines?", "mackerel", "anchov(y|ies)"),
  shellfish: word("shrimp", "prawns?", "scallops?", "crab", "lobster", "mussels?", "clams?", "oysters?"),
  egg: word("eggs?", "omelet", "omelette", "frittata", "scrambled"),
  tofu: word("tofu", "tempeh", "edamame", "seitan"),
  game: word("deer", "venison", "elk", "bison", "buffalo", "game meat", "game", "boar", "rabbit", "moose"),
  lamb: word("lamb", "mutton", "goat"),
  duck: word("duck", "goose"),
};

/** Every protein the meal's words name. */
export function proteinsNamed(words: string): Set<Protein> {
  return new Set((Object.keys(PROTEIN_WORDS) as Protein[]).filter((kind) => PROTEIN_WORDS[kind].test(words)));
}

/** A rule's photo fits the meal: its dish matches, and a protein it shows is the meal's only protein. */
export function photoFits(rule: MealArtRule, words: string): boolean {
  if (!rule.match(words)) return false;
  if (!rule.shows) return true;
  const named = proteinsNamed(words);
  return named.has(rule.shows) && named.size === 1;
}

export const MEAL_ART_RULES: MealArtRule[] = [
  // --- original five, unchanged ---
  { match: (w) => /\bscallops?\b/.test(w), image: "/meal-art/scallops.webp" },
  { match: (w) => /\beggs?\b/.test(w) && /\brice\b/.test(w), image: "/meal-art/eggs-rice.webp" },
  { match: (w) => /\bchicken\b/.test(w), image: "/meal-art/chicken.webp" },
  { match: (w) => /\b(whey|shake|smoothie)\b|protein powder/.test(w), image: "/meal-art/shake.webp" },
  {
    match: (w) => /\b(yogurt|yoghurt|cottage cheese)\b/.test(w)
      && /\b(berry|berries|strawberry|strawberries)\b/.test(w),
    image: "/meal-art/yogurt.webp",
  },

  // --- dish shapes (checked before raw proteins, so e.g. a chicken burrito photographs as a burrito) ---
  { match: (w) => word("sushi", "poke", "sashimi", "nigiri").test(w), image: "/meal-art/sushi-poke.webp" },
  { match: (w) => word("taco", "tacos", "burrito", "burritos", "quesadilla").test(w), image: "/meal-art/tacos-burrito.webp" },
  { match: (w) => word("sandwich", "wrap", "sub", "panini", "blt").test(w), image: "/meal-art/sandwich-wrap.webp" },
  { match: (w) => /\bpizza\b/.test(w), image: "/meal-art/pizza.webp" },
  { match: (w) => word("pasta", "spaghetti", "penne", "noodles?", "lasagna", "macaroni", "linguine", "fettuccine").test(w), image: "/meal-art/pasta.webp" },
  { match: (w) => word("curry", "tikka masala", "korma", "vindaloo").test(w), image: "/meal-art/curry.webp" },
  { match: (w) => /stir[\s-]?fry/.test(w) || /\bwok\b/.test(w), image: "/meal-art/stir-fry.webp" },
  { match: (w) => word("soup", "stew", "chili", "chowder", "bisque").test(w), image: "/meal-art/soup-stew.webp" },
  { match: (w) => /\bsalad\b/.test(w), image: "/meal-art/salad.webp" },
  { match: (w) => word("oatmeal", "porridge", "overnight oats", "rolled oats").test(w), image: "/meal-art/oats-porridge.webp" },
  { match: (w) => word("pancakes?", "waffles?", "french toast").test(w), image: "/meal-art/pancakes.webp" },
  { match: (w) => /\bavocado\b/.test(w) && /\btoast\b/.test(w), image: "/meal-art/toast-avocado.webp" },

  // --- proteins (generic catches once the dish-shape checks above found nothing) ---
  { match: (w) => /\bsalmon\b/.test(w), image: "/meal-art/salmon.webp" },
  // Albacore, skipjack and yellowfin are tuna.
  { match: (w) => PROTEIN_WORDS.tuna.test(w), image: "/meal-art/tuna.webp" },
  { match: (w) => word("shrimp", "prawns?").test(w), image: "/meal-art/shrimp.webp" },
  { match: (w) => word("cod", "halibut", "tilapia", "snapper", "mahi", "sea bass", "trout", "white fish", "fish fillet", "fish").test(w), image: "/meal-art/white-fish.webp" },
  { match: (w) => /\bturkey\b/.test(w), image: "/meal-art/turkey.webp" },
  { match: (w) => word("pork", "bacon", "ham", "sausage", "prosciutto", "chorizo", "pepperoni", "salami").test(w), image: "/meal-art/pork.webp" },
  { match: (w) => word("steak", "sirloin", "ribeye", "filet mignon", "strip steak", "flank steak", "skirt steak", "chuck roast", "brisket").test(w), image: "/meal-art/beef-steak.webp" },
  { match: (w) => /ground beef/.test(w) || word("burger", "meatballs?", "bolognese").test(w), image: "/meal-art/ground-beef.webp" },
  { match: (w) => word("tofu", "tempeh", "edamame").test(w), image: "/meal-art/tofu.webp" },
  { match: (w) => word("eggs?", "omelet", "omelette", "frittata", "scrambled").test(w), image: "/meal-art/eggs.webp" },

  // --- dairy, snacks and sides ---
  { match: (w) => word("yogurt", "yoghurt", "frozen yogurt").test(w), image: "/meal-art/yogurt-fruit.webp" },
  { match: (w) => word("protein bar", "energy bar", "energy bites?", "granola bar", "protein balls?").test(w), image: "/meal-art/protein-bar-snack.webp" },
  { match: (w) => word("nuts", "almonds?", "walnuts?", "cashews?", "peanuts?", "trail mix", "dried fruit", "pistachios?").test(w), image: "/meal-art/nuts-fruit-snack.webp" },
  { match: (w) => /cottage cheese/.test(w), image: "/meal-art/cottage-cheese.webp" },
  // Rice is a side to whatever protein is named. The rice bowl photo is sliced chicken on rice, so it
  // stands only for chicken and rice; rice beside any other protein, or none, gets the olive art.
  { match: (w) => /\brice\b/.test(w), image: "/meal-art/rice-bowl.webp", shows: "chicken" },
  { match: (w) => word("potato", "potatoes", "sweet potato", "sweet potatoes").test(w), image: "/meal-art/potatoes-sweet-potato.webp" },
  // The balanced plate is a grilled chicken breast with rice and vegetables: chicken only, never a
  // catch-all for a meal nothing above recognised (DESIGN.md: unknown dishes show the olive art).
  { match: () => true, image: BALANCED_PLATE_IMAGE, shows: "chicken" },
];
