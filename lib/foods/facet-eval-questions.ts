/**
 * The facet evaluator's fixed question set (scripts/eval/jev-facets), owned here so the payload
 * builder (lib/ai/payloads.ts facetEvalPayload) builds it and no caller chooses questions
 * (Phase 13 §9 R3). The wording is frozen at rubric v1 (occasion facets included): the committed
 * eval cache hashes it. The v2 occasion rubric has its own evaluator,
 * scripts/eval/facets-occasion-eval.ts.
 */
import type { Question, Questions } from "@/lib/ai/jev-types";
import type { FacetFoodInput } from "@/lib/foods/facet-keys";
import { facetQuestions, facetState } from "@/lib/foods/facet-questions";

export type FacetEvalKind = "facets" | "portion";
export type FacetEvalItem = {
  id: string;
  food: FacetFoodInput;
  portion?: { amount: number; unit: string; context: string };
};
export type FacetEvalCase = FacetFoodInput & { amount?: number; serving?: string };

export function facetEvalState(item: FacetEvalItem, kind: FacetEvalKind): FacetEvalCase {
  const food = facetState(item.food);
  if (kind === "facets") return food;
  if (!item.portion) throw new Error(`Portion case ${item.id} has no portion`);
  return { ...food, amount: item.portion.amount,
    serving: `${item.portion.unit} ${item.portion.context}` };
}

export function facetEvalQuestions(items: readonly FacetEvalItem[], kind: FacetEvalKind): Questions {
  const questions: Questions = {};
  for (const item of items) {
    const entries = kind === "facets"
      ? { ...facetQuestions(item.food, undefined, "v1"), not_human_food: notHumanFoodQuestion() }
      : { portion_level: portionQuestion() };
    for (const [name, question] of Object.entries(entries)) {
      questions[`${item.id}::${name}`] = questionForCase(item.id, question);
    }
  }
  return questions;
}

function questionForCase(caseId: string, question: Question): Question {
  return { ...question,
    instructions: `Evaluate only state.cases[${JSON.stringify(caseId)}]. ${question.instructions}` };
}

function notHumanFoodQuestion(): Question {
  return {
    type: "noul",
    instructions: "Is this item not a food or drink intended for humans to consume?",
    criteria: {
      true: "It is pet food, packaging, a non-food object, or a supplement sold only as a dose.",
      false: "It is a food, drink, or food ingredient intended for humans, even when preparation is still required.",
    },
  };
}

function portionQuestion(): Question {
  return {
    type: "score",
    instructions: "Judge the semantic plausibility of this already-normalized per-serving amount; do no arithmetic or unit conversion.",
    criteria: [
      "Far too small to be a plausible serving of this food in the stated context.",
      "Small but still a plausible serving of this food in the stated context.",
      "A typical plausible serving of this food in the stated context.",
      "Large but still a plausible serving of this food in the stated context.",
      "Far too large to be a plausible serving of this food in the stated context.",
    ],
  };
}
