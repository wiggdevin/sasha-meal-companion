import { allergenFacts } from "@/lib/coach/policy";
import type { FoodHit } from "@/lib/coach/executors";
import type { FoodSearchBlockV1 } from "@/lib/coach/ui-blocks";
import { evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";

export type FoodSearchArgs = {
  query: string;
  intent?: "browse" | "eats" | "avoid" | "lookup";
  limit?: number;
};

export function hydrateFoodSearch(
  id: string,
  args: FoodSearchArgs,
  hits: readonly FoodHit[],
  profile: ConstraintProfile,
): FoodSearchBlockV1 | null {
  if (!args.intent || args.intent === "lookup") return null;
  const limit = args.limit ?? 5;
  const results = hits.flatMap((hit) => {
    if (!hit.foodRefId || !Number.isInteger(hit.catalogFoodRevisionId)) return [];
    const blocked = evaluatePolicy(profile, {
      foodRefId: hit.foodRefId,
      allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit),
      foodName: hit.name,
      category: hit.category ?? null,
      onEatsList: hit.prefStatus === "eats",
      onAvoidList: hit.prefStatus === "avoid",
    }).verdict === "blocked";
    const status: "eats" | "avoid" | "neutral" = hit.prefStatus ?? "neutral";
    return [{
      foodRefId: hit.foodRefId,
      revisionId: String(hit.catalogFoodRevisionId),
      name: hit.name,
      ...(hit.kcalPer100g === null ? {} : { kcalPer100g: hit.kcalPer100g }),
      status,
      blocked,
    }];
  }).slice(0, limit);
  if (results.length === 0) return null;
  return {
    kind: "food_search", v: 1, id, query: args.query,
    intent: args.intent === "browse" ? "log" : args.intent,
    results, truncated: hits.length > limit,
  };
}
