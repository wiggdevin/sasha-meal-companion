"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import RecipeSheet from "@/components/RecipeSheet";
import RecipeHub from "@/components/recipes-hub/RecipeHub";
import Disclosure from "@/components/ui/Disclosure";
import RecipeDiscovery from "@/components/RecipeDiscovery";
import { MacroFigure } from "@/components/nutrition/MacroText";
import { listRecipes, recipeServingNutrition, type RecipeRow } from "@/lib/recipes-client";
import { servingBound } from "@/lib/nutrition-display";
import { listFavorites, toggleFavorite } from "@/lib/favorites-client";
import type { RecipeAccess } from "@/lib/recipe-access-client";
import { currentAccountOrNull, isCurrent, onAccountGone, onAccountReady } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
import Notice from "@/components/ui/Notice";

/* DESIGN.md Iconography: linear, currentColor, drawn as inline SVG — never emoji or a text
   glyph. Filled when the recipe is a favorite, outline when it is not. */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9Z" />
    </svg>
  );
}

/**
 * Saved recipes, on Eats. This was `/recipes`, a tab of its own reached by a pill on the Foods
 * title row — one more place to look for a food the user can eat. It is a section here, and
 * `id="recipes"` is what the old route now redirects to.
 */
export default function RecipesSection({ recipeAccess = { enabled: false, loading: false } }: {
  recipeAccess?: Pick<RecipeAccess, "enabled" | "loading"> & Partial<Pick<RecipeAccess, "unavailable" | "retry">>;
}) {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  // Editing a saved recipe opens its editor; New recipe opens the recipe widget in place below.
  const [open, setOpen] = useState<RecipeRow | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [hubMounted, setHubMounted] = useState(false);
  const openCard = (next: boolean) => { setCardOpen(next); if (next) setHubMounted(true); };
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [starError, setStarError] = useState<string | null>(null);

  async function refresh() {
    const h = currentAccountOrNull();
    if (!h) return;
    try { const rows = await listRecipes(); if (isCurrent(h)) setRecipes(rows); }
    catch { /* Account changed while reading; the ready listener loads the new list. */ }
  }

  async function refreshFavorites() {
    const h = currentAccountOrNull();
    if (!h) return;
    try {
      const rows = await listFavorites();
      if (isCurrent(h)) setFavoriteIds(new Set(rows.filter((r) => r.kind === "recipe").map((r) => r.id)));
    } catch { /* The next account-ready event reloads this list. */ }
  }

  async function toggleRecipeStar(recipe: RecipeRow) {
    const h = currentAccountOrNull();
    if (!h) return;
    setStarError(null);
    try {
      await toggleFavorite("recipe", recipe.id, undefined, { name: recipe.name });
      if (isCurrent(h)) await refreshFavorites();
    } catch {
      if (isCurrent(h)) setStarError("Could not change this favorite. Try again.");
    }
  }

  // Every way into recipes opens the card first: the old /recipes route (#recipes), a link to
  // discovery (#discover-recipes), and a shared-recipe favorite tapped above (`catalog-recipe-open`),
  // which then needs discovery scrolled into view once the card has opened.
  const [revealDiscovery, setRevealDiscovery] = useState(0);
  useEffect(() => {
    const reveal = (discovery: boolean) => {
      setCardOpen(true); setHubMounted(true);
      if (discovery) setRevealDiscovery((count) => count + 1);
    };
    const fromHash = () => {
      const hash = window.location.hash;
      if (hash === "#recipes" || hash === "#discover-recipes") reveal(hash === "#discover-recipes");
    };
    const fromFavorite = () => reveal(true);
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("catalog-recipe-open", fromFavorite);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("catalog-recipe-open", fromFavorite);
    };
  }, []);
  useEffect(() => {
    if (revealDiscovery === 0) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById("discover-recipes")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [revealDiscovery]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void refreshFavorites();
    const offGone = onAccountGone(() => {
      setRecipes([]); setFavoriteIds(new Set()); setOpen(null); setCardOpen(false); setHubMounted(false);
      setStarError(null);
    });
    const offReady = onAccountReady(() => { void refresh(); void refreshFavorites(); });
    const onSynced = () => { void refresh(); void refreshFavorites(); };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => { offGone(); offReady(); window.removeEventListener(SYNCED_EVENT, onSynced); };
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {/* One card (owner, 2026-10-05: "all of the recipes section should be combined into one
          expandable card"): the header names it and counts it; the new-recipe widget, search,
          filters and the saved list open inside. /recipes lands here (#recipes) and opens it. */}
      <section id="recipes" className="flex flex-col gap-3">
        {starError && <Notice tone="error" title={starError} />}
        <Disclosure title="Recipes" heading={2} open={cardOpen} onOpenChange={openCard}
          aside={`${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}`}>
          <div className="flex flex-col gap-4 pt-1">
            {/* Opening the card IS the new-recipe widget (owner, 2026-10-05: "the expansion portion
                should just automatically go to the new recipe page … not a child card"). It mounts on
                the first open and stays mounted, so a save in flight survives the card folding. */}
            {hubMounted && <RecipeHub embedded access={recipeAccess} onClose={() => setCardOpen(false)}
              onSaved={() => { void refresh(); }} />}

            {recipeAccess.enabled ? <RecipeDiscovery /> : recipeAccess.unavailable
              ? <Notice tone="attention" title="Recipe access could not be checked. Try again."
                action={recipeAccess.retry ? { label: "Retry", onClick: recipeAccess.retry } : undefined} />
              : recipeAccess.loading
              ? <p className="m-0 text-caption text-muted" role="status">Checking recipe access…</p>
              : <Notice tone="attention" title="Shared recipes and Shopping are not available for this account yet." />}

            {recipes.length === 0 ? (
              <Notice tone="neutral"
                title="Nothing saved yet. A recipe is a tray you make often — save it once, log a serving after." />
            ) : (
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Saved recipes">
                {recipes.map((recipe, index) => {
                  const favorited = favoriteIds.has(recipe.id);
                  // #21: the stored serving, read through its coverage; a partial one says "at least".
                  const serving = recipeServingNutrition(recipe);
                  return (
                    <li key={recipe.id}
                      className={`flex items-center gap-2 py-3 ${index === 0 ? "" : "border-t border-hairline"}`}>
                      <button type="button" onClick={() => setOpen(recipe)}
                        className="tap flex min-w-0 flex-1 flex-col gap-1 text-left">
                        <span className="text-body font-medium text-charcoal">
                          {recipe.name.trim() || "Untitled recipe"}
                        </span>
                        <span className="text-tiny font-normal text-graphite">
                          {recipe.servings} {recipe.servings === 1 ? "serving" : "servings"}
                          {serving.kcal !== null && serving.kcal > 0 && <>
                            {" · "}<MacroFigure macro="kcal" value={serving.kcal}
                              bound={servingBound(serving.nutritionComplete)} /> a serving</>}
                        </span>
                      </button>
                      <button type="button" onClick={() => void toggleRecipeStar(recipe)}
                        aria-pressed={favorited}
                        aria-label={favorited ? `Remove ${recipe.name} from favorites` : `Favorite ${recipe.name}`}
                        className={`tap flex min-h-11 min-w-11 shrink-0 items-center justify-center ${favorited ? "text-primary" : "text-icon"}`}>
                        <StarIcon filled={favorited} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Disclosure>
      </section>

      <AnimatePresence>
        {open && (
          <RecipeSheet key="recipe-sheet"
            recipe={open}
            onClose={() => setOpen(null)}
            onSaved={() => { setOpen(null); void refresh(); }}
            onDeleted={() => { setOpen(null); void refresh(); }} />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
