"use client";
/**
 * Whether an ingredient of this recipe was added to the Avoid rules since it was shown (the
 * `recipe-avoid-changed` event from components/RecipeDetails.tsx). Planning stops until a new search.
 */
import { useEffect, useState } from "react";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

export function useAvoidChanged(recipe: Pick<RecipeCandidate, "ingredients">): boolean {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const listen = (event: Event) => {
      const name = (event as CustomEvent<unknown>).detail;
      if (typeof name === "string" && recipe.ingredients.some((item) => item.name.toLowerCase() === name.toLowerCase()))
        setChanged(true);
    };
    window.addEventListener("recipe-avoid-changed", listen);
    return () => window.removeEventListener("recipe-avoid-changed", listen);
  }, [recipe]);
  return changed;
}
