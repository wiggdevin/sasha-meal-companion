/**
 * The fixed Jev question set for the coach intent pre-pass (purpose `coach-intent`). The payload
 * builder (lib/ai/payloads.ts intentPayload) calls intentQuestions; no caller chooses questions
 * (Phase 13 §9 R3). Pure: the browser graph reaches this module through lib/ai/payloads.ts.
 */
import { choice, noul } from "@/lib/ai/jev-types";

const INTENT_CRITERIA = {
  shift_schedule: "Move one or more planned meal times earlier or later.",
  log_food: "Record food or a meal the person already ate.",
  plan_meal: "Set or plan a meal for one or more dates; the food has not been eaten yet.",
  suggest_options: "Offer meal, snack, or recipe options to choose from.",
  add_to_eats: "Add a food to the person's Eats list.",
  add_to_avoid: "Add a food to the person's Avoid list.",
  remove_from_eats: "Remove a food from the person's Eats list.",
  remove_from_avoid: "Remove a food from the person's Avoid list.",
  log_water: "Record water the person drank.",
  use_shopping_list: "Turn \"use my shopping list\" on or off, so meals favor list and pantry foods.",
  log_weight: "Record the person's body weight.",
  update_profile: "Change body, activity, goal, or dietary profile data.",
  set_targets: "Change calorie or macro targets directly.",
  show_chart: "Show or graph weight progress, this week's calories, or today's macros.",
  question: "Ask for information or an explanation without requesting a change.",
  other: "Anything that does not fit another intent.",
} as const;

export function baseQuestions() {
  return {
    intent: choice("Choose the single best intent for `message`.", INTENT_CRITERIA),
    direction: choice("If meal times move, choose their direction; otherwise speculate.", {
      later: "Move the time later in the day.",
      earlier: "Move the time earlier in the day.",
    }),
    scope: choice("If a schedule moves, choose its scope; otherwise speculate.", {
      all: "Every meal or the whole schedule, including past slots.",
      remaining: "Only meals still ahead or not yet eaten.",
      one_slot: "One named meal or slot only.",
    }),
    suggest_kind: choice("If options are requested, choose their kind; otherwise speculate.", {
      meal: "Meal options.",
      snack: "Snack options.",
      recipe: "Recipe options.",
    }),
    suggest_count: choice("If options are requested, choose the requested count or default to 3.", {
      "1": "One option.",
      "2": "Two options.",
      "3": "Three options, including when no count is stated.",
      "4": "Four options.",
      "5": "Five options.",
    }),
    suggest_slot: choice("Choose a slot only when `message` explicitly names it; otherwise choose none.", {
      none: "No meal or ritual slot is explicitly named.",
      coffee: "The coffee slot.",
      "pouches-pre": "The pre-training carbs slot.",
      "post-refuel": "The post-training refuel slot.",
      "meal-1": "Meal 1 or the first meal.",
      "meal-2": "Meal 2 or the second meal.",
      "meal-3": "Meal 3 or the third meal.",
      "meal-4": "Meal 4 or the fourth meal.",
      "meal-5": "Meal 5 or the fifth meal.",
      "meal-6": "Meal 6 or the sixth meal.",
      "hot-chocolate": "The hot chocolate slot.",
    }),
    fit_remaining: noul("Does the person ask for suggestions that fit their remaining macros?"),
    mentions_specific_foods: noul(
      "Does the suggestion request name a specific food, ingredient, dish, or flavour it wants? "
      + "A generic request to use the Eats list is not a specific food.",
    ),
    mentions_size: noul(
      "Does the suggestion request name a size, serving count, calorie amount, or gram amount?",
    ),
    time_amount_stated: noul("Does `message` explicitly state how far to move the schedule?"),
    water_amount_stated: noul("Does `message` explicitly state an amount of water to log?"),
    weight_stated: noul("Does `message` explicitly state a body weight to log?"),
  };
}

/**
 * The fixed intent question set, plus `which_number` when the message holds several numbers (its
 * options are those numbers, already in the payload's state). The payload builder
 * (lib/ai/payloads.ts intentPayload) calls this; no caller chooses questions (Phase 13 §9 R3).
 */
export function intentQuestions(numbers: readonly { raw: string }[]) {
  const base = baseQuestions();
  if (numbers.length <= 1) return base;
  return { ...base, which_number: choice(
    "Which numeric candidate supplies the winning intent's amount? Choose none if none does.",
    Object.fromEntries([
      ...numbers.map(({ raw }) => [raw, `The amount written as '${raw}'.`]),
      ["none", "None of these numbers supplies the winning intent's amount."],
    ]) as Record<string, string>,
  ) };
}
