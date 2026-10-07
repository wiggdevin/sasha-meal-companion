"use client";

import { useEffect, useState } from "react";
import RecipeResults from "@/components/RecipeResults";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import { assertCurrent, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { getCatalogFavorite, setCatalogFavorite } from "@/lib/recipe-catalog-client";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import Notice from "@/components/ui/Notice";
import { RecipeFreshness } from "@/lib/recipes/recipe-freshness";

export default function CatalogRecipeResults({ recipes, limitations = [], blockId, sourceEpoch,
  initialDate, initialSlotId, onPlanned, nested, stale = false }: {
  recipes: RecipeCandidate[]; limitations?: string[]; blockId: string; sourceEpoch?: number;
  initialDate?: string; initialSlotId?: string; onPlanned?: () => void;
  /** Drawn inside another card (a meal card's Plan flow): the result cards drop their own shadow. */
  nested?: boolean;
  /** The owner's re-read after a rule change is running: every card says "Checking…" meanwhile. */
  stale?: boolean;
}) {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [states, setStates] = useState<Record<string, { favorite: boolean; revision: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState<RecipeCandidate | null>(null);
  const ids = recipes.map((recipe) => recipe.recipeId).join(",");
  useEffect(() => {
    const ready = onAccountReady(setAccount);
    const gone = onAccountGone(() => { setAccount(null); setStates({}); setPlanning(null); });
    return () => { ready(); gone(); };
  }, []);
  useEffect(() => {
    if (!account) return;
    let live = true;
    void Promise.all(recipes.map(async (recipe) => [recipe.recipeId,
      await getCatalogFavorite(recipe.recipeId)] as const)).then((rows) => {
      if (live) { assertCurrent(account); setStates(Object.fromEntries(rows)); setError(null); }
    }).catch((cause) => {
      if (live) setError(cause instanceof Error ? cause.message : "Favorites could not load.");
    });
    return () => { live = false; };
  // The catalog results are immutable for this block; account epoch changes start a fresh load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, account?.epoch]);
  async function toggle(recipe: RecipeCandidate) {
    if (!account) throw new Error("Sign in before saving a favorite.");
    const current = states[recipe.recipeId] ?? await getCatalogFavorite(recipe.recipeId);
    const next = await setCatalogFavorite(recipe.recipeId, !current.favorite, current.revision);
    assertCurrent(account);
    setStates((rows) => ({ ...rows, [recipe.recipeId]: next }));
    window.dispatchEvent(new Event("catalog-favorite-changed"));
  }
  if (!account || sourceEpoch !== undefined && sourceEpoch !== account.epoch)
    return <p role="status">Checking recipes for this account…</p>;
  return <RecipeFreshness.Provider value={{ stale }}><div className="flex flex-col gap-2">
    <RecipeResults key={`${account.epoch}:${blockId}`} recipes={recipes} limitations={limitations} nested={nested}
      favoriteIds={Object.entries(states).filter(([, value]) => value.favorite).map(([id]) => id)}
      actions={{ onFavorite: toggle, onFit: (recipe) => setPlanning(recipe),
        fitPanel: (recipe) => planning?.revisionId === recipe.revisionId ? <RecipePlanFlow key={planning.revisionId}
          recipe={planning} initialDate={initialDate} initialSlotId={initialSlotId} onPlanned={onPlanned}
          onClose={() => setPlanning(null)} /> : null }}
      persistenceKey={`${account.userId}:${blockId}`} placement={{ initialDate, initialSlotId, onPlanned }} />
    {error && <Notice tone="error" title={error} />}
  </div></RecipeFreshness.Provider>;
}
