"use client";

import { useEffect, useState } from "react";
import CatalogRecipeResults from "@/components/CatalogRecipeResults";
import { getCatalogRecipe, transientRecipeReadFailure } from "@/lib/recipe-catalog-client";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import { useRecipeAccess } from "@/lib/recipe-access-client";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { recipesJudgedNow, useRecipeReader } from "@/lib/recipes/recipe-freshness";
import Notice from "@/components/ui/Notice";

export default function RecipeResultsBlock({ blockId, recipes, limitations, exactMatch }: {
  blockId: string; recipes: RecipeCandidate[]; limitations?: string[];
  /** False when no recipe carried every searched word: these are the closest, not an exact match. */
  exactMatch?: boolean;
}) {
  const access = useRecipeAccess();
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  type Read = { epoch: number; recipes: RecipeCandidate[]; unavailable: string[] };
  const [current, setCurrent] = useState<Read | null>(null);
  // One reader (lib/recipes/recipe-freshness.ts): only the newest read lands, and a rule change reads
  // the shown recipes again ("Checking…" meanwhile). A read with a transient detail failure is a
  // failed read: it never lands a shorter or empty list, the shown cards stay, and it is retried
  // (30 s, then every 2 min), the first read too, which has nothing else to show meanwhile.
  const { reader, stale } = useRecipeReader<Read>({ apply: setCurrent, retryAsks: true,
    judged: (read) => recipesJudgedNow(read.recipes) });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const ready = onAccountReady((next) => { reader.clear(); setAccount(next); setCurrent(null); });
    const gone = onAccountGone(() => { reader.clear(); setAccount(null); setCurrent(null); });
    return () => { ready(); gone(); };
  }, [reader]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") { setCurrent(null); setRevision((value) => value + 1); }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const ids = recipes.map((recipe) => `${recipe.recipeId}:${recipe.revisionId}`).join("|");
  useEffect(() => {
    if (!account || !access.enabled) return;
    const epoch = account.epoch;
    void reader.read((signal) => Promise.all(recipes.map(async (stored) => {
      try {
        const fresh = await getCatalogRecipe(stored.recipeId, signal);
        return fresh.publicationState === "published" && fresh.revisionId === stored.revisionId
          ? { recipe: fresh, unavailable: null }
          : { recipe: null, unavailable: `${stored.name}: the saved revision changed. Search again for the current recipe.` };
      } catch (cause) {
        if (transientRecipeReadFailure(cause)) throw cause;
        return { recipe: null, unavailable: `${stored.name}: source access could not be confirmed. Its saved details are hidden.` };
      }
    })).then((results): Read => {
      if (currentAccountOrNull()?.epoch !== epoch) throw new Error("Account changed.");
      return { epoch, recipes: results.flatMap((result) => result.recipe ? [result.recipe] : []),
        unavailable: results.flatMap((result) => result.unavailable ? [result.unavailable] : []) };
    }));
  // The stored block cannot change in place; account and revision IDs define the read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.epoch, access.enabled, ids, revision]);
  if (!access.enabled) return <p role="status">{access.loading ? "Checking recipe access…" : "Shared recipes are unavailable for this account."}</p>;
  if (!current || current.epoch !== account?.epoch) return <p role="status">Checking current recipe access…</p>;
  return <div className="flex flex-col gap-2">
    {/* O4a: ranking never filters, so a search with no exact match still shows its closest recipes. */}
    {exactMatch === false && current.recipes.length > 0 && <Notice tone="neutral" title="No exact match, closest recipes" />}
    <CatalogRecipeResults blockId={blockId} sourceEpoch={current.epoch} recipes={current.recipes}
      stale={stale}
      limitations={[...(limitations ?? []), ...current.unavailable,
        ...(recipes.length === 0 && (limitations?.length ?? 0) === 0
          ? ["Saved recipe details are unavailable. Search again for current recipes."] : [])]} />
  </div>;
}
