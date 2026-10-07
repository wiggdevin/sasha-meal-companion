/**
 * The fixed Jev question set for the dietary-preference text (purpose `profile-prefs`). The payload
 * builder (lib/ai/payloads.ts prefsPayload) owns which questions are asked; no caller chooses them
 * (Phase 13 §9 R3). Pure: no runtime imports beyond the question helpers.
 */
import { choice, noul } from "@/lib/ai/jev-types";
import { PREFERENCE_FLAGS, type PreferenceFlag } from "@/lib/profile/onboarding-state";

export const COOKING_EFFORT_CHOICES = {
  none: "The person explicitly wants meals that require no cooking.",
  minimal: "The person explicitly wants only quick, simple cooking or assembly.",
  full: "The person explicitly says they are willing to cook full meals.",
  unstated: "The text says nothing about how much cooking effort the person wants.",
} as const;

type Criteria = { yes: string; no: string };

const CRITERIA: Record<PreferenceFlag, Criteria> = {
  vegetarian: {
    yes: "The person says they are vegetarian or do not eat meat or fish.",
    no: "They do not state a vegetarian preference.",
  },
  vegan: {
    yes: "The person says they are vegan or avoid all animal products.",
    no: "They do not state a vegan preference; vegetarian alone is not vegan.",
  },
  pescatarian: {
    yes: "The person says they are pescatarian or eat fish but not other meat.",
    no: "They do not state a pescatarian preference.",
  },
  no_pork: {
    yes: "The person says they do not eat pork or pork products.",
    no: "They do not state that pork is excluded.",
  },
  no_beef: {
    yes: "The person says they do not eat beef.",
    no: "They do not state that beef is excluded.",
  },
  no_shellfish: {
    yes: "The person says they cannot or do not eat shellfish.",
    no: "They do not state that shellfish is excluded.",
  },
  no_eggs: {
    yes: "The person says they cannot or do not eat eggs.",
    no: "They do not state that eggs are excluded.",
  },
  no_soy: {
    yes: "The person says they cannot or do not eat soy.",
    no: "They do not state that soy is excluded.",
  },
  no_peanuts: {
    yes: "The person says they cannot or do not eat peanuts.",
    no: "They do not state that peanuts are excluded.",
  },
  low_fodmap: {
    yes: "The person explicitly follows or wants a low-FODMAP diet.",
    no: "They do not explicitly request low FODMAP.",
  },
  halal: {
    yes: "The person says their food must be halal.",
    no: "They do not request halal food.",
  },
  kosher: {
    yes: "The person says their food must be kosher.",
    no: "They do not request kosher food.",
  },
};

const FLAG_QUESTIONS = Object.fromEntries(PREFERENCE_FLAGS.map((flag) => [
    flag,
    noul(`Does the dietary preference text meet the ${flag.replaceAll("_", " ")} criterion?`,
      CRITERIA[flag]),
  ])) as Record<PreferenceFlag, ReturnType<typeof noul>>;

export const PREF_QUESTIONS = {
  ...FLAG_QUESTIONS,
  cooking_effort: choice(
    "Choose the cooking effort explicitly stated in the text. Never infer it; choose unstated when the text says nothing about cooking effort.",
    COOKING_EFFORT_CHOICES,
  ),
  mentions_specific_foods: noul(
    "Does the text name one or more specific foods the person avoids or wants more of?",
    {
      yes: "At least one specific food or ingredient is named.",
      no: "Only broad dietary patterns are mentioned, or no food is named.",
    },
  ),
};

