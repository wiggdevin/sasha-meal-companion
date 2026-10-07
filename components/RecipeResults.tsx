"use client";

import { useState } from "react";
import RecipeResultCard, { type RecipeActions } from "@/components/RecipeResultCard";
import type { Placement } from "@/components/recipes-hub/PutInMeal";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import Notice from "@/components/ui/Notice";

export default function RecipeResults({ recipes, status = "ready", error, onRetry, actions,
  favoriteIds = [], persistenceKey, limitations = [], placement, nested }: { recipes: RecipeCandidate[]; limitations?: string[];
  /** The cards sit inside another card (RecipeResultCard `nested`). */
  nested?: boolean;
  status?: "loading" | "ready" | "error"; error?: string; onRetry?: () => void;
  actions?: RecipeActions; favoriteIds?: string[]; persistenceKey?: string;
  /** Where "Put it in a meal" starts: the day and meal being viewed. Omitted, the card has no picker. */
  placement?: Placement }) {
  const [expandedIds, setExpandedIds] = useState<string[]>(() => {
    if (!persistenceKey || typeof sessionStorage === "undefined") return [];
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(`recipe-expanded:${persistenceKey}`) ?? "[]");
      return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
    }
    catch { return []; }
  });
  function change(id: string, expanded: boolean) {
    const next = expanded ? [...new Set([...expandedIds, id])] : expandedIds.filter((value) => value !== id);
    setExpandedIds(next);
    if (persistenceKey && typeof sessionStorage !== "undefined") {
      try { sessionStorage.setItem(`recipe-expanded:${persistenceKey}`, JSON.stringify(next)); } catch { /* storage is optional */ }
    }
  }
  if (status === "loading") return <p role="status">Finding complete recipes…</p>;
  if (status === "error") return <Notice tone="error" title={error ?? "Recipes could not load."}
    action={onRetry ? { label: "Retry", onClick: onRetry } : undefined} />;
  if (!recipes.length) return <div className="flex flex-col items-start gap-2">
    <Notice tone="neutral" title="No complete recipe matched this request and your current rules."
      action={onRetry ? { label: "Try again", onClick: onRetry } : undefined} />
    {limitations.length > 0 && <ul className="m-0 list-disc pl-5">{limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
  </div>;
  return <div className="flex flex-col gap-3" aria-label="Recipe results">
    {recipes.map((recipe) => <RecipeResultCard key={recipe.revisionId} recipe={recipe}
      expanded={expandedIds.includes(recipe.revisionId)}
      onExpandedChange={(value) => change(recipe.revisionId, value)}
      favorite={favoriteIds.includes(recipe.recipeId)} actions={actions} placement={placement} nested={nested} />)}
  </div>;
}
