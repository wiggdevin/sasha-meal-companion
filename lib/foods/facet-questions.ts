import { noul, type NoulQuestion } from "@/lib/ai/jev-types";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import {
  FACETS, OCCASION_RUBRIC_VERSION, RUBRIC_VERSION, type Facet, type OccasionFacet,
} from "@/lib/foods/facet-vocabulary";

export { OCCASION_RUBRIC_VERSION, RUBRIC_VERSION };

type Rubric = { instructions: string; criteria: { true: string; false: string } };

/**
 * Phase 17 O3, D6: cuisine-diverse reference dishes for each occasion, so the rubric does not
 * read "breakfast" as a North American breakfast. They are examples of usual practice, not a
 * list the food must be on.
 */
export const OCCASION_DISH_EXAMPLES: Readonly<Record<"breakfast" | "lunch" | "dinner" | "snack", string>> = {
  breakfast: "idli with sambar or poha (South Asia); congee, or rice with miso soup and grilled fish (East Asia); "
    + "huevos rancheros, chilaquiles or arepas (Latin America); ful medames, labneh with bread, or menemen "
    + "(Mediterranean and Middle East); oatmeal, eggs with toast, or cereal with milk (North America and Europe); "
    + "akara with ogi, or waakye (West Africa)",
  lunch: "dal with rice or roti, or biryani (South Asia); ramen, bibimbap or a rice bento (East Asia); tacos, or "
    + "rice and beans with chicken (Latin America); a falafel wrap or Greek salad with bread (Mediterranean); a "
    + "sandwich, or soup and salad (North America and Europe); jollof rice with chicken, or waakye (West Africa)",
  dinner: "chicken curry with rice or naan (South Asia); a stir-fry with rice, or hot pot (East Asia); mole with "
    + "chicken and tortillas, or feijoada (Latin America); grilled fish with vegetables, or moussaka "
    + "(Mediterranean); a roast with potatoes, or pasta (North America and Europe); egusi soup with fufu, or "
    + "groundnut stew with rice (West Africa)",
  snack: "samosa, pakora or roasted chana (South Asia); rice crackers, onigiri or edamame (East Asia); elote, or "
    + "fruit with chili and lime (Latin America); hummus with pita, or nuts and dried fruit (Mediterranean); an "
    + "apple, yogurt or a granola bar (North America and Europe); puff-puff, chin chin or roasted groundnuts "
    + "(West Africa)",
};

const RUBRICS: Record<Facet, Rubric> = {
  human_food: {
    instructions: "Is this item a food or drink intended for humans to consume?",
    criteria: {
      true: "A person would ordinarily eat or drink the item as food or beverage.",
      false: "The item is not human food or drink, such as pet food, packaging, a non-food object, or a supplement sold only as a dose.",
    },
  },
  requires_preparation: {
    instructions: "Must this food be cooked or otherwise prepared before it is ready to eat as described?",
    criteria: {
      true: "The described item still needs cooking, mixing, reconstitution, or another substantive preparation step before eating.",
      false: "The described item is ready to eat or drink; opening, unwrapping, or optional reheating alone does not count.",
    },
  },
  breakfast_fit: occasionFit("breakfast"),
  lunch_fit: occasionFit("lunch"),
  dinner_fit: occasionFit("dinner"),
  snack_fit: occasionFit("snack"),
  meat: {
    instructions: "Does this food contain meat from a land animal?",
    criteria: {
      true: "The food contains flesh, organs, stock, gelatin, or another meat-derived ingredient from a land animal, including poultry.",
      false: "The food contains no land-animal meat; fish, shellfish, eggs, dairy, and plant foods alone are false.",
    },
  },
  fish_seafood: {
    instructions: "Does this food contain fish or seafood?",
    criteria: {
      true: "The food contains finfish, shellfish, or another aquatic animal used as seafood, including their stocks or extracts.",
      false: "The food contains no fish, shellfish, or other seafood-derived ingredient.",
    },
  },
  shellfish: {
    instructions: "Does this food contain shellfish?",
    criteria: {
      true: "The food contains a crustacean or mollusc, including shrimp, crab, lobster, crawfish, clam, mussel, oyster, scallop, squid, or octopus.",
      false: "The food contains no crustacean or mollusc; finfish alone is false.",
    },
  },
  animal_product: {
    instructions: "Does this food contain any animal-derived ingredient?",
    criteria: {
      true: "The food contains meat, seafood, dairy, egg, honey, gelatin, animal fat, or another ingredient obtained from an animal.",
      false: "Every stated ingredient is plant, fungal, mineral, or synthetic and no animal-derived ingredient is indicated.",
    },
  },
  pork: {
    instructions: "Does this food contain pork or a pig-derived ingredient?",
    criteria: {
      true: "The food contains pork, ham, bacon, lard, pig gelatin, or another pig-derived ingredient.",
      false: "The food contains no pig-derived ingredient.",
    },
  },
  beef: {
    instructions: "Does this food contain beef or a cattle-derived meat ingredient?",
    criteria: {
      true: "The food contains beef, veal, beef stock, beef tallow, cattle gelatin, or another cattle-derived meat ingredient.",
      false: "The food contains no cattle-derived meat ingredient; dairy alone is false.",
    },
  },
  alcohol: {
    instructions: "Does this food or drink contain beverage alcohol as consumed?",
    criteria: {
      true: "The item is an alcoholic drink or contains ethanol from an alcoholic ingredient that remains in the food as consumed.",
      false: "The item contains no beverage alcohol; sugar alcohols and fully alcohol-free flavour names are false.",
    },
  },
  contains_gluten: allergen("gluten", "wheat, barley, rye, malt, or another gluten-containing ingredient"),
  contains_dairy: allergen("dairy", "milk, butter, cheese, whey, casein, cream, or another milk-derived ingredient"),
  contains_egg: allergen("egg", "egg, albumen, mayonnaise made with egg, or another egg-derived ingredient"),
  contains_peanut: allergen("peanut", "peanut, peanut oil, peanut flour, or another peanut-derived ingredient"),
  contains_tree_nut: allergen("tree nut", "almond, cashew, walnut, pecan, pistachio, hazelnut, macadamia, Brazil nut, or another tree-nut ingredient"),
  contains_soy: allergen("soy", "soybean, soy protein, tofu, tempeh, miso, soy sauce, or another soy-derived ingredient"),
  contains_sesame: allergen("sesame", "sesame seed, tahini, sesame oil, or another sesame-derived ingredient"),
  raw_cruciferous: {
    instructions: "Is this food an uncooked cruciferous vegetable as eaten?",
    criteria: {
      true: "The item is an uncooked cruciferous vegetable, such as broccoli, cauliflower, cabbage, kale, Brussels sprouts, bok choy, arugula, radish, or watercress.",
      false: "The item is cooked, preserved, or not a cruciferous vegetable; a composed food that merely includes one is false.",
    },
  },
  raw_leafy_greens: {
    instructions: "Is this food an uncooked leafy green as eaten?",
    criteria: {
      true: "The item is an uncooked leafy green, such as lettuce, spinach, chard, endive, romaine, arugula, watercress, or spring mix.",
      false: "The item is cooked, preserved, or not a leafy green; a composed food that merely includes one is false.",
    },
  },
  onion_garlic: {
    instructions: "Does this food contain onion, garlic, or another culinary allium?",
    criteria: {
      true: "The food contains onion, garlic, shallot, leek, scallion, chive, or ramp as the food or an ingredient, including dried or powdered forms.",
      false: "The food contains no stated culinary allium; a flavour name without evidence of an allium ingredient is false.",
    },
  },
  beans: {
    instructions: "Does this food contain whole or recognizably intact mature beans or pulses?",
    criteria: {
      true: "The food contains whole or recognizably intact mature beans, lentils, chickpeas, edamame, soybeans, cowpeas, fava beans, lima beans, or split peas.",
      false: "The food contains no whole or recognizably intact mature bean or pulse; tofu, tempeh, hummus, refried beans, sprouts, green beans, green peas, oils, and lecithin are false.",
    },
  },
  simple_sugars: {
    instructions: "Is this food itself a simple sweetener or sweet spread?",
    criteria: {
      true: "The item itself is honey, sugar, syrup, agave sweetener, molasses, jam, jelly, marmalade, preserves, or a comparable concentrated sweetener.",
      false: "The item is not itself a sweetener or sweet spread; a baked good, confection, drink, fruit, condiment, or other food that merely contains sugar is false.",
    },
  },
};

/** Minimal provider state: canonical food facts only, never account, health, note, or policy data. */
export function facetState(food: FacetFoodInput): FacetFoodInput {
  return {
    name: food.name,
    ...optional("brand", food.brand),
    ...optional("description", food.description),
    ...optional("preparation", food.preparation),
    ...optional("ingredientsText", food.ingredientsText),
  };
}

/**
 * The rubric questions for `facets`. "current" is what the warm job asks and stores (occasion
 * facets at OCCASION_RUBRIC_VERSION, the rest at RUBRIC_VERSION). "v1" is the frozen rubric-v1
 * wording the committed jev-facets eval cache hashes (lib/foods/facet-eval-questions.ts); it is
 * never used to judge a food for the cache.
 */
export function facetQuestions(
  _food: FacetFoodInput,
  facets: readonly Facet[] = FACETS,
  rubric: "current" | "v1" = "current",
): Record<string, NoulQuestion> {
  return Object.fromEntries([...new Set(facets)].map((facet) => {
    const chosen = rubric === "v1" && facet in V1_OCCASION_RUBRICS
      ? V1_OCCASION_RUBRICS[facet as OccasionFacet] : RUBRICS[facet];
    return [facet, noul(chosen.instructions, chosen.criteria)];
  }));
}

/**
 * Rubric v2 for an occasion facet (Phase 17 O3, D6): typical practice for most people who eat the
 * food, judged per food against dish examples from several cuisines. "Possible but unusual" is
 * false; the ranking maps a weak or uncertain answer to neutral, never to a penalty
 * (lib/meals/facet-affinity.ts), so a false here never forbids anything.
 */
function occasionFit(meal: keyof typeof OCCASION_DISH_EXAMPLES): Rubric {
  const at = meal === "snack" ? "as a snack" : `at ${meal}`;
  return {
    instructions: `Is this food a typical choice ${at} for most people who eat this food?`,
    criteria: {
      true: `Most people who eat this food, in the food cultures where it is commonly eaten, would usually `
        + `choose it ${at}, on its own or as part of a usual ${meal} dish. Typical ${meal} dishes across `
        + `cuisines include ${OCCASION_DISH_EXAMPLES[meal]}.`,
      false: `Most people who eat this food would not usually choose it ${at}: eating it then is possible `
        + `but unusual. Judge common practice for the food itself, not a schedule, a health goal or a rule.`,
    },
  };
}

/** Rubric v1 for the occasion facets, frozen for the committed jev-facets eval cache only. */
const V1_OCCASION_RUBRICS: Readonly<Record<OccasionFacet, Rubric>> = {
  breakfast_fit: mealFit("breakfast"),
  lunch_fit: mealFit("lunch"),
  dinner_fit: mealFit("dinner"),
  snack_fit: mealFit("a snack"),
};

/** Rubric v1 wording (retired for the cache by OCCASION_RUBRIC_VERSION 2). */
function mealFit(meal: string): Rubric {
  return {
    instructions: `Is this food conventionally suitable to eat as ${meal}?`,
    criteria: {
      true: `Across at least one ordinary food culture, the item is conventionally eaten as ${meal} or as a component of ${meal}.`,
      false: `The item is not conventionally suitable as ${meal}; judge the food itself, not a particular person's schedule or preference.`,
    },
  };
}

function allergen(label: string, examples: string): Rubric {
  return {
    instructions: `Does this food contain ${label}, or does its label warn that it may contain ${label}?`,
    criteria: {
      true: `The food states ${examples}, or carries a trace or cross-contact warning for ${label}.`,
      false: `The food states no ${label} ingredient or ${label} cross-contact warning.`,
    },
  };
}

function optional<K extends keyof FacetFoodInput>(
  key: K,
  value: FacetFoodInput[K],
): Partial<Pick<FacetFoodInput, K>> {
  return typeof value === "string" && value.trim() !== "" ? { [key]: value } as Pick<FacetFoodInput, K> : {};
}
