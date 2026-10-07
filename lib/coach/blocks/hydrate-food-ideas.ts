import {
  composedMealSchema,
  type FoodIdeasBlockV1,
} from "@/lib/coach/ui-blocks";

export function hydrateFoodIdeas(id: string, rawIdeas: unknown): FoodIdeasBlockV1 | null {
  if (!Array.isArray(rawIdeas)) return null;
  const ideas = rawIdeas.flatMap((idea) => {
    const parsed = composedMealSchema.safeParse(idea);
    return parsed.success ? [parsed.data] : [];
  });
  return ideas.length > 0 ? { kind: "food_ideas", v: 1, id, ideas } : null;
}
