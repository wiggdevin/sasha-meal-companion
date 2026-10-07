"use client";
/**
 * The catalog, one swipe at a time (owner ask 2026-10-03: the cards were "so thin you can't even
 * tell"): ivory cards with a hairline and a soft drop on the widget's beige recess, each with a
 * rounded photo, the name, one serving's calories in bold `.kcal` and protein in plum, and a tag for
 * whether that serving fits what is left today (sage "Fits today", Dijon "~N kcal over"). A tap
 * opens the recipe in place under the row: the skimmable details (components/RecipeDetails.tsx),
 * Put it in a meal (components/recipes-hub/PutInMeal.tsx) and Adjust portion through the catalog's
 * plan flow (components/RecipePlanFlow.tsx). Only accounts with recipe access see it. Focus
 * follows the open card down into its detail, and comes back to the card when the detail closes
 * (the card tapped again, or Escape inside the detail): iOS Safari does not focus a tapped button,
 * so without this focus fell to the page when the detail unmounted.
 *
 * The read is stamped with the account bound when it starts (audit r4): the widget stays mounted
 * across an account change, and one account's rule-filtered list must never paint for another.
 *
 * A read that has already settled is dropped the same way (audit f2 BLOCKER): an `onAccountGone`
 * listener clears the painted list, the open card and any catalog match the moment the account
 * changes, not only while a read is still in flight, and a fresh read starts for whichever account
 * is current next.
 *
 * A stale read's own completion never speaks for the account that is current now (audit g1
 * MAJOR): once a fetch is no longer `ours()` — aborted, or the account moved on — both branches
 * do nothing at all. The account-gone/-ready listeners above are the only ones who paint
 * "Account changed" or clear it; a fetch that merely lost the race stays silent rather than
 * clobbering whatever a newer fetch (or listener) already painted for the account now bound. No
 * fetch starts with no account bound at all.
 */
import Tag from "@/components/ui/Tag";
import RuleMark from "@/components/ui/RuleMark";
import { phoneRulesKey, RecipeFreshness, recipesJudgedNow, shownRecipeRuleMark, useRecipeReader }
  from "@/lib/recipes/recipe-freshness";
import type { RecipeSearchResponse } from "@/lib/recipe-catalog-client";
import Button from "@/components/ui/Button";
import { useEffect, useRef, useState } from "react";
import RecipeDetails from "@/components/RecipeDetails";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import { canFit } from "@/components/RecipeResultCard";
import { ingredientLine, specificPhoto } from "@/components/recipes-hub/SuggestionCard";
import SuggestionCarousel from "@/components/recipes-hub/SuggestionCarousel";
import PutInMeal from "@/components/recipes-hub/PutInMeal";
import { useAvoidChanged } from "@/components/recipes-hub/useAvoidChanged";
import { currentAccountOrNull, isCurrent, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { searchCatalogRecipes } from "@/lib/recipe-catalog-client";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { fitLabel, fitToday, recipePhoto, servingFacts, type Fit } from "@/lib/recipes-hub/hub";
import type { Macros } from "@/lib/types";

/** The pilot catalog is 25 recipes; one read brings all of them. */
export const CAROUSEL_LIMIT = 25;

/** A fit is sage; over is Dijon, the warning role (DESIGN.md §Colors). Unknown shows no tag. */
export function FitTag({ fit }: { fit: Fit }) {
  const label = fitLabel(fit);
  if (!label) return null;
  return <Tag data-fit={fit.kind} size="md" tone={fit.kind === "fits" ? "sage" : "yellow"} className="self-start">{label}</Tag>;
}

/** What a recipe card shows once it has grown in place: the skimmable recipe (its photo and name are
 *  the card's own) with Put it in a meal and Adjust portion right under the nutrition. */
function Details({ recipe, date, onPlanned }: { recipe: RecipeCandidate; date: string; onPlanned?: () => void }) {
  const [adjusting, setAdjusting] = useState(false);
  const rulesChanged = useAvoidChanged(recipe);
  const plannable = !rulesChanged && canFit(recipe);
  return <RecipeDetails recipe={recipe} titled={false} date={date}
    actions={<div role="group" aria-label={`${recipe.name} actions`} className="flex flex-col gap-2">
      <PutInMeal recipe={recipe} disabled={!plannable} initialDate={date} onPlanned={onPlanned} />
      {adjusting ? <RecipePlanFlow recipe={recipe} initialDate={date} onPlanned={onPlanned}
        onClose={() => setAdjusting(false)} />
        : <Button block disabled={rulesChanged} onClick={() => setAdjusting(true)}>Adjust portion</Button>}
      {!plannable && <p className="m-0 text-tiny text-muted">{rulesChanged
        ? "Your Avoid list changed. Search again before planning this recipe."
        : "Putting it in a meal needs complete energy and macro values. Adjust portion can still preview it."}</p>}
    </div>} />;
}

export default function RecipeCarousel({ remaining, date, onPlanned }: {
  remaining: Macros | null; date: string; onPlanned?: () => void;
}) {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [recipes, setRecipes] = useState<RecipeCandidate[] | null>(null);
  const [failed, setFailed] = useState<"error" | "account" | null>(null);
  // One reader (lib/recipes/recipe-freshness.ts): a rule change marks the shown cards "Checking…"
  // and reads the catalog again; the cards stay, and only the newest answer lands.
  const { reader, stale } = useRecipeReader<RecipeSearchResponse>({
    apply: (result) => { setRecipes(result.recipes); setFailed(null); },
    judged: (result) => recipesJudgedNow(result.recipes),
  });
  const shown = useRef(false);
  useEffect(() => { shown.current = recipes !== null; }, [recipes]);
  // A settled list is one account's own: the moment the bound account changes, drop it rather
  // than leave it painted for whoever is bound next (audit f2 BLOCKER).
  useEffect(() => {
    const gone = onAccountGone(() => { reader.clear(); setAccount(null); setRecipes(null); setFailed("account"); });
    const ready = onAccountReady((next) => { reader.clear(); setAccount(next); setRecipes(null); setFailed(null); });
    return () => { gone(); ready(); };
  }, [reader]);
  useEffect(() => {
    if (!account) return;
    const h = account;
    void reader.read((signal) => {
      if (!isCurrent(h)) return Promise.reject(new Error("Account changed."));
      return searchCatalogRecipes({ query: "", limit: CAROUSEL_LIMIT }, signal);
    }).then((outcome) => {
      // A failed read with cards already shown keeps them (still "Checking…" after a rule change).
      if (outcome.status === "failed" && isCurrent(h) && !shown.current) setFailed("error");
    });
    // Re-runs only when the bound account actually changes; the listeners above already cleared the
    // stale state and the reader. A superseded or aborted read never speaks for the account bound now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.userId, account?.epoch]);
  if (failed) return <p role="status" className="m-0 text-caption text-graphite">{failed === "account"
    ? "Account changed. Close and reopen." : "The recipe catalog didn’t load. Ask below instead."}</p>;
  if (!recipes) return <p role="status" className="m-0 text-caption text-graphite">Loading recipes…</p>;
  if (recipes.length === 0) return <p role="status" className="m-0 text-caption text-graphite">No catalog recipes fit your food rules yet.</p>;
  // One card system with Swap and a menu's picks: a tap grows the card in place to the whole recipe
  // (components/recipes-hub/SuggestionCarousel.tsx).
  const phoneKey = phoneRulesKey();
  return <RecipeFreshness.Provider value={{ stale }}>
  <section aria-label="Recipe catalog" className="flex min-w-0 flex-col">
    {/* No recessed tray around the row (owner, 2026-10-05: the open card sat in "a hollow space"):
        the row bleeds to the panel's edges like Swap's, and an open card fills the width. */}
    <SuggestionCarousel label="Recipes" items={recipes.map((recipe) => ({
        id: recipe.recipeId, name: recipe.name, image: specificPhoto(recipePhoto(recipe)),
        description: ingredientLine([...recipe.ingredients].sort((a, b) => a.seq - b.seq)),
        values: { ...servingFacts(recipe), carbs: null, fat: null }, only: ["kcal", "protein"] as const,
        tag: <span className="flex flex-wrap items-center gap-1">
          <FitTag fit={fitToday(servingFacts(recipe), remaining)} />
          <RuleMark variant="tag" mark={shownRecipeRuleMark(recipe, stale, phoneKey)} className="self-start" />
        </span>,
        // Open, the details say the mark once (RecipeDetails' line): the tag keeps only the fit.
        openTag: <FitTag fit={fitToday(servingFacts(recipe), remaining)} />,
        detail: <Details recipe={recipe} date={date} onPlanned={onPlanned} />,
      }))} />
  </section>
  </RecipeFreshness.Provider>;
}
