import type { CatalogRecipe, RecipeCandidate } from "@/lib/recipe-catalog/types";

const words = (value: string) => new Set(value.toLocaleLowerCase("en")
  .match(/[\p{L}\p{N}]+/gu) ?? []);

/** Rank already policy-eligible options by dish/cuisine resemblance, never by safety. */
export function similarRecipeOptions(
  current: Pick<CatalogRecipe, "name" | "cuisine" | "dishTags" | "totalMinutes">,
  options: readonly RecipeCandidate[], excludedRecipeId?: string,
): RecipeCandidate[] {
  const names = words(current.name);
  const tags = new Set(current.dishTags.map((tag) => tag.toLocaleLowerCase("en")));
  return options.filter((option) => option.eligibility.status === "eligible"
    && option.recipeId !== excludedRecipeId)
    .map((option) => {
      const score = (current.cuisine && option.cuisine?.toLocaleLowerCase("en")
        === current.cuisine.toLocaleLowerCase("en") ? 6 : 0)
        + option.dishTags.filter((tag) => tags.has(tag.toLocaleLowerCase("en"))).length * 3
        + [...words(option.name)].filter((word) => names.has(word)).length
        - (current.totalMinutes !== null && option.totalMinutes !== null
          ? Math.min(3, Math.abs(current.totalMinutes - option.totalMinutes) / 15) : 0);
      return { option, score };
    }).sort((a, b) => b.score - a.score || a.option.name.localeCompare(b.option.name))
    .slice(0, 3).map(({ option }) => option);
}
