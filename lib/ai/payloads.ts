/**
 * Phase 13 §2 and §9 R3 (slice 0): one typed payload builder per Jev purpose, and the only way to
 * make a value the TypeSafe adapter accepts. (Gemini's builders are lib/ai/gemini-payloads.ts.)
 *
 * A builder is not a filter. It takes its purpose's typed fields and constructs a NEW object from
 * exactly those fields, so an extra property a caller passes (a name, a note, a whole profile row)
 * never reaches `JSON.stringify`. The builder also owns the QUESTIONS: each purpose's question set
 * is fixed code, and a caller can only choose among it through typed, bounded parameters (a flag,
 * a kind, a candidate list). No caller writes question text.
 *
 * The payload is deep-frozen and its purpose is recorded in a private WeakMap. Minting is private
 * to this module; `jevProvenance` is the only read. lib/ai/typesafe.ts refuses anything whose
 * recorded purpose is missing or differs from the one it claims, including a hand-made object
 * cast to the branded type.
 *
 * No node: imports: a client-reachable module (lib/coach/role-advice.ts) builds a Jev payload.
 */
import type { Part } from "@google/genai";
import type { PurposeOf } from "@/lib/ai/call-registry";
import { deepFreeze } from "@/lib/ai/freeze";
import type { NoulQuestion, ScoreQuestion } from "@/lib/ai/jev-types";
import { intentQuestions } from "@/lib/coach/intent-questions";
import { ROLE_QUESTION, type NutrientBucket } from "@/lib/coach/role-advice";
import { questionsFor } from "@/lib/coach/suggest-questions";
import { VERIFY_QUESTIONS } from "@/lib/coach/verify-question";
import {
  facetEvalQuestions, facetEvalState, type FacetEvalItem, type FacetEvalKind,
} from "@/lib/foods/facet-eval-questions";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import { facetQuestions } from "@/lib/foods/facet-questions";
import { OCCASION_FACETS, type Facet } from "@/lib/foods/facet-vocabulary";
import { pairItemQuestion, pairItemState, type PairItem } from "@/lib/foods/pairing/questions";
import { NOT_HUMAN_FOOD_QUESTION, PORTION_LEVEL_QUESTION } from "@/lib/log/sanity-questions";
import { PREF_QUESTIONS } from "@/lib/profile/pref-questions";
import { chipFamily, tasteQuestions } from "@/lib/profile/taste-chips";
import { tasteTextRoute } from "@/lib/profile/taste-safety";

declare const JEV_BRAND: unique symbol;
declare const GEMINI_BRAND: unique symbol;

export type JevPurpose = PurposeOf<"typesafe">;
export type GeminiPurpose = PurposeOf<"google">;

/** Builder output for TypeSafe System One. `state` and `questions` are all Jev ever sees. */
export type JevPayload<P extends JevPurpose = JevPurpose, Q = unknown> = {
  readonly [JEV_BRAND]: P;
  readonly purpose: P;
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Q;
};

export type Media = { bytes: Uint8Array; mimeType: string };

/** Builder output for Gemini (lib/ai/gemini-payloads.ts): the parts and optional media only. */
export type GeminiPayload<P extends GeminiPurpose = GeminiPurpose> = {
  readonly [GEMINI_BRAND]: P;
  readonly purpose: P;
  readonly parts: readonly Part[];
  readonly media?: Readonly<Media>;
};

/** The purpose each Jev payload was minted for. Private: only this module's builders write it. */
const provenance = new WeakMap<object, JevPurpose>();

function jev<P extends JevPurpose, Q>(
  purpose: P, state: Record<string, unknown>, questions: Q,
): JevPayload<P, Q> {
  const payload = deepFreeze({ purpose, state, questions: structuredClone(questions) });
  provenance.set(payload, purpose);
  return payload as unknown as JevPayload<P, Q>;
}

/** The purpose a Jev builder minted this value for, or null for anything else. */
export function jevProvenance(value: unknown): JevPurpose | null {
  return typeof value === "object" && value !== null ? provenance.get(value) ?? null : null;
}

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  (value === undefined ? {} : { [key]: value } as Record<K, V>);

/**
 * The food fields a Jev payload may carry: name, brand, description, preparation, ingredients.
 * Same rule as facetState (lib/foods/facet-questions.ts): a blank optional field is left out.
 */
function foodFields(food: FacetFoodInput): FacetFoodInput {
  const text = (value: string | null | undefined) =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  return {
    name: food.name,
    ...optional("brand", text(food.brand)),
    ...optional("description", text(food.description)),
    ...optional("preparation", text(food.preparation)),
    ...optional("ingredientsText", text(food.ingredientsText)),
  };
}

// ---- Jev builders -----------------------------------------------------------------------------

export type IntentNumber = { value: number; unit: string | null; raw: string };
export type IntentState = {
  message: string; now: string; foodsMentioned?: readonly string[];
  numbers: readonly IntentNumber[];
};

/**
 * `coach-intent` (D1): the user's message, the clock, parsed numbers and matched food names. The
 * questions are the fixed intent set; `which_number` is added only when there are several numbers.
 */
export function intentPayload(input: IntentState) {
  const numbers = input.numbers.map((n) => ({ value: n.value, unit: n.unit, raw: n.raw }));
  return jev("coach-intent", {
    message: input.message,
    now: input.now,
    ...optional("foodsMentioned", input.foodsMentioned ? [...input.foodsMentioned] : undefined),
    numbers,
  }, intentQuestions(numbers));
}

/** `profile-prefs` (D1): the dietary preference text the user typed, against the fixed flag set. */
export function prefsPayload(input: { text: string }) {
  return jev("profile-prefs", { text: input.text }, PREF_QUESTIONS);
}

/**
 * `profile-taste` (D1, Phase 18 W5b): a taste text that passed the local safety check, sent as
 * typed, and the canonical food families it names (at most four) — nothing else: no profile, no
 * rule, no stored taste or cuisine. The builder runs the safety check again and refuses text it
 * keeps local, so a caller can never send health, symptom, rule or unsure text (D9 item 3).
 */
export function tastePayload(input: { text: string; families: readonly string[] }) {
  if (tasteTextRoute(input.text).route !== "send") {
    throw new Error("taste text the local check keeps is never sent to Jev or any model");
  }
  const families = input.families.map((family) => {
    const canonical = chipFamily(family);
    if (canonical === null) throw new Error("taste families must be canonical family names");
    return canonical;
  });
  return jev("profile-taste", { text: input.text, foods: families }, tasteQuestions(families));
}

export type VerifyState = {
  reply: string;
  actions: readonly { kind: string; summary: string }[];
  toolNames: readonly string[];
};

/** `coach-verify` (D1): the reply, one line per action, and the read-only tool names. */
export function verifyPayload(input: VerifyState) {
  return jev("coach-verify", {
    reply: input.reply,
    actions: input.actions.map((action) => ({ kind: action.kind, summary: action.summary })),
    tools_ran: { access: "read_only", names: [...input.toolNames] },
  }, VERIFY_QUESTIONS);
}

export type SuggestState = {
  slot: { id: string | null; label: string | null };
  wish: string | null;
  candidates: readonly {
    index: number;
    foods: readonly { name: string; grams: number }[];
    macros: { kcal: number; protein: number; carbs: number; fat: number };
  }[];
};

/**
 * `suggest-options` (D1): the slot, the wish text and the sized candidate meals. One fixed
 * plausibility question per candidate; the kind picks the wording from a closed set.
 */
export function suggestPayload(input: SuggestState, kind: "meal" | "snack" | "recipe") {
  const candidates = input.candidates.map((candidate) => ({
    index: candidate.index,
    foods: candidate.foods.map((food) => ({ name: food.name, grams: food.grams })),
    macros: { kcal: candidate.macros.kcal, protein: candidate.macros.protein,
      carbs: candidate.macros.carbs, fat: candidate.macros.fat },
  }));
  return jev("suggest-options", {
    slot: { id: input.slot.id, label: input.slot.label },
    wish: input.wish,
    candidates,
  }, questionsFor(kind, candidates.length));
}

export type RoleState = {
  food: { name: string; description: string | null; prepState: string | null };
  nutrientBuckets: { protein: NutrientBucket; carb: NutrientBucket; fat: NutrientBucket };
};

/** `meal-component-role` (D1): one food and its macro buckets — never grams or a person. */
export function rolePayload(input: RoleState) {
  return jev("meal-component-role", {
    food: { name: input.food.name, description: input.food.description,
      prepState: input.food.prepState },
    nutrientBuckets: { protein: input.nutrientBuckets.protein, carb: input.nutrientBuckets.carb,
      fat: input.nutrientBuckets.fat },
  }, { meal_component_role: ROLE_QUESTION });
}

export type SanityQuestions = { not_human_food?: NoulQuestion; portion_level?: ScoreQuestion };

/** `log_sanity` (D1): one food and its per-serving grams and kcal; the two fixed questions. */
export function sanityPayload(
  input: { food: FacetFoodInput;
    amounts: { gramsPerServing: number | null; kcalPerServing: number | null } },
  ask: { notHumanFood: boolean; portion: boolean },
) {
  const questions: SanityQuestions = {
    ...(ask.notHumanFood ? { not_human_food: NOT_HUMAN_FOOD_QUESTION } : {}),
    ...(ask.portion ? { portion_level: PORTION_LEVEL_QUESTION } : {}),
  };
  return jev("log_sanity", {
    food: foodFields(input.food),
    amounts: { gramsPerServing: input.amounts.gramsPerServing,
      kcalPerServing: input.amounts.kcalPerServing },
  }, questions);
}

/**
 * `food_facets` (D0/D1): food records only, each with the facets still missing for it. The rubric
 * questions are the fixed facet vocabulary (lib/foods/facet-questions.ts); question ids are
 * `food_<index>__<facet>`.
 */
export function facetPayload(input: {
  foods: readonly { food: FacetFoodInput; facets: readonly Facet[] }[];
}) {
  const questions: Record<string, NoulQuestion> = {};
  input.foods.forEach((item, index) => {
    for (const [facet, question] of Object.entries(facetQuestions(item.food, [...item.facets]))) {
      questions[`food_${index}__${facet}`] = { ...question,
        instructions: `Evaluate only state.foods[${index}]. ${question.instructions}` };
    }
  });
  return jev("food_facets", { foods: input.foods.map((item) => foodFields(item.food)) }, questions);
}

/**
 * `jev_occasion_eval` (D0): the occasion-rubric calibration holdout (Phase 17 O3,
 * scripts/eval/facets-occasion.holdout.json) — labelled synthetic foods and dishes, never a user's
 * food. Each case is asked exactly the four production occasion questions (rubric v2,
 * lib/foods/facet-questions.ts); question ids are `<caseId>::<facet>`. Case ids are bounded slugs.
 */
export function occasionEvalPayload(input: { items: readonly { id: string; food: FacetFoodInput }[] }) {
  const questions: Record<string, NoulQuestion> = {};
  const cases: Record<string, unknown> = {};
  for (const item of input.items) {
    if (!/^[a-z0-9-]{1,64}$/.test(item.id)) throw new Error("occasion eval case id must be a short slug");
    cases[item.id] = foodFields(item.food);
    for (const [facet, question] of Object.entries(facetQuestions(item.food, OCCASION_FACETS))) {
      questions[`${item.id}::${facet}`] = { ...question,
        instructions: `Evaluate only state.cases[${JSON.stringify(item.id)}]. ${question.instructions}` };
    }
  }
  return jev("jev_occasion_eval", { cases }, questions);
}

/**
 * `jev_facets_eval` (D0): the facet evaluator's labelled synthetic cases (scripts/eval/jev-facets),
 * never a user's food. State and questions come from lib/foods/facet-eval-questions.ts, whose
 * wording the committed eval cache hashes.
 */
export function facetEvalPayload(input: { kind: FacetEvalKind; items: readonly FacetEvalItem[] }) {
  return jev("jev_facets_eval", {
    cases: Object.fromEntries(input.items.map((item) => [item.id, facetEvalState(item, input.kind)])),
  }, facetEvalQuestions(input.items, input.kind));
}

/**
 * `pair_plausibility` (D0, Phase 18 W1c): offline pair and plate-pattern labels. Each item is a
 * catalog anchor name, one to three catalog side names and a stated occasion
 * (lib/foods/pairing/questions.ts validates them); the one fixed question per item is the frozen
 * rubric, with question id = item id.
 */
export function pairPlausibilityPayload(input: { items: readonly PairItem[] }) {
  const items: Record<string, unknown> = {};
  const questions: Record<string, NoulQuestion> = {};
  for (const item of input.items) {
    items[item.id] = pairItemState(item);
    questions[item.id] = pairItemQuestion(item.id);
  }
  return jev("pair_plausibility", { items }, questions);
}
