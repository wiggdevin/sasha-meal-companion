"use client";
/**
 * One catalog recipe in a result list: an ivory card whose header row (photo, serif name, calories in
 * the shared `.kcal` colour, protein in plum) grows in place into the recipe's hero, followed by the
 * skimmable details (components/RecipeDetails.tsx) with the actions right under the macro strip: Put
 * it in a meal (components/recipes-hub/PutInMeal.tsx), Save recipe and Adjust portion.
 */
import Image from "next/image";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Button from "@/components/ui/Button";
import Fold from "@/components/ui/Fold";
import Thinking from "@/components/ui/Thinking";
import RuleMark from "@/components/ui/RuleMark";
import { useShownRecipeRuleMark } from "@/lib/recipes/recipe-freshness";
import type { RuleMark as RuleMarkValue } from "@/lib/types";
import RecipeDetails from "@/components/RecipeDetails";
import { ServingKcal } from "@/components/nutrition/RecipeNutrition";
import { MacroLine } from "@/components/nutrition/MacroText";
import PutInMeal, { type Placement } from "@/components/recipes-hub/PutInMeal";
import { useAvoidChanged } from "@/components/recipes-hub/useAvoidChanged";
import { spring } from "@/lib/design/motion";
import { RECIPE_MACROS, type RecipeCandidate } from "@/lib/recipe-catalog/types";
import { recipePhoto, servingFacts } from "@/lib/recipes-hub/hub";
import photoArt from "@/components/ui/MealPhoto.module.css";
import { displayMinutes } from "@/lib/recipes/preview-display";
import { MEAL_TITLE } from "@/lib/design/meal-type";

export type RecipeActions = {
  onFavorite?: (recipe: RecipeCandidate) => Promise<void> | void;
  onFit?: (recipe: RecipeCandidate) => Promise<void> | void;
  /** The Adjust portion panel for this recipe while it is open, else null. It opens inside the card,
   *  under the button that asked for it; drawn after the whole list, it opened out of sight at the
   *  bottom of a scrolling panel and the button seemed to do nothing (owner, 2026-10-04). */
  fitPanel?: (recipe: RecipeCandidate) => ReactNode;
};

export function canFit(recipe: RecipeCandidate): boolean {
  return recipe.publicationState === "published" && recipe.eligibility.status === "eligible" &&
    recipe.ingredients.length > 0 && recipe.steps.length > 0 &&
    recipe.source.rightsKind !== "link_only" &&
    RECIPE_MACROS.every((key) => {
      const value = recipe.nutritionPerServing[key];
      return value !== undefined && value.status !== "unknown" && value.value !== null;
    }) && recipe.ingredients.every((ingredient) => RECIPE_MACROS.every((key) => {
      const value = ingredient.nutrition[key];
      return value !== undefined && value.status !== "unknown" && value.value !== null;
    }));
}

/** "508 kcal · 51g PRO", the standard nutrition text (docs/design/KIT.md §13). */
export function ServingLine({ recipe, className = "" }: { recipe: RecipeCandidate; className?: string }) {
  const facts = servingFacts(recipe);
  return <span className={`tabular-nums ${className}`}>
    <MacroLine only={["kcal", "protein"]} values={{ kcal: facts.kcal, protein: facts.protein, carbs: null, fat: null }} />
  </span>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
    strokeLinecap="round" strokeLinejoin="round"
    className={`size-5 shrink-0 text-muted transition-transform duration-300 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}>
    <path d="M6 9l6 6 6-6" /></svg>;
}

/** Whether the eligibility alert (shown open for a recipe that is not eligible) already says the
 *  mark's reason: the server builds the mark from those same reasons, so one of them is enough. */
export function alertStatesMark(recipe: Pick<RecipeCandidate, "eligibility">, mark: RuleMarkValue | null | undefined): boolean {
  if (!mark || recipe.eligibility.status === "eligible") return false;
  return recipe.eligibility.reasons.some((reason) => reason.message.trim() !== ""
    && (mark.reason === reason.message || mark.reason.endsWith(` ${reason.message}`)));
}

export default function RecipeResultCard({ recipe, expanded, onExpandedChange, favorite = false,
  actions = {}, placement, nested = false }: { recipe: RecipeCandidate; expanded: boolean; onExpandedChange: (value: boolean) => void;
  favorite?: boolean; actions?: RecipeActions; placement?: Placement;
  /** Inside another card (a meal card's Plan flow): a hairline, no shadow of its own (E0). */
  nested?: boolean }) {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rulesChanged = useAvoidChanged(recipe);
  const ruleMark = useShownRecipeRuleMark(recipe);
  const complete = recipe.ingredients.length > 0 && recipe.steps.length > 0 && recipe.source.rightsKind !== "link_only";
  const plannable = !rulesChanged && canFit(recipe);
  async function run(label: string, action: RecipeActions[keyof RecipeActions]) {
    if (!action) return;
    setBusy(label); setError(null);
    try { await action(recipe); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This action failed. Try again."); }
    finally { setBusy(null); }
  }
  const move = spring("smooth", reduce);
  const detailId = `recipe-detail-${recipe.revisionId}`;
  const hasActions = Boolean(placement || actions.onFavorite || actions.onFit);
  const fitPanel = actions.fitPanel?.(recipe) ?? null;
  const photoSrc = recipePhoto(recipe);
  return <article className={nested ? "w-full" : "shell w-full"} data-nested={nested || undefined}>
    <div className="overflow-hidden rounded-3xl border border-hairline bg-surface">
      <button type="button" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => onExpandedChange(!expanded)}
        // The button fills its clipped card, so its keyboard ring is drawn inside the card's edge.
        className={`tap flex min-h-11 w-full rounded-[inherit] text-left focus-visible:-outline-offset-4! ${expanded ? "flex-col gap-3 p-4 pb-0" : "items-center gap-3 p-3"}`}>
        <motion.span layout={reduce ? false : "position"} transition={move}
          className={`block shrink-0 overflow-hidden rounded-2xl ${expanded ? "h-44 w-full" : "size-16"}`}>
          {photoSrc ? <Image src={photoSrc} alt="" width={736} height={352} sizes={expanded ? "400px" : "64px"}
            className="size-full object-cover" /> : <span aria-hidden="true" className={`block size-full ${photoArt.clip}`} />}
        </motion.span>
        <span className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-start justify-between gap-3">
              <strong className={`block ${expanded ? MEAL_TITLE.hero : `line-clamp-2 ${MEAL_TITLE.standard}`}`}>
                {recipe.name}</strong>
              {expanded && <ServingKcal kcal={servingFacts(recipe).kcal} />}
            </span>
            {!expanded && <span className="flex flex-col gap-0.5 text-tiny">
              <ServingLine recipe={recipe} />
              <span className="text-muted">{recipe.cuisine ? `${recipe.cuisine} · ` : ""}{recipe.totalMinutes === null
                ? "Time unknown" : displayMinutes(recipe.totalMinutes)} · {recipe.servings} servings</span>
              {/* Closed, the tag alone (its reason is read with it); open, RecipeDetails gives the line. */}
              <RuleMark variant="tag" mark={ruleMark} className="mt-0.5 self-start" />
            </span>}
          </span>
          <Chevron open={expanded} />
        </span>
      </button>
      {expanded && <div id={detailId} className="flex flex-col gap-3 p-4">
        {recipe.publicationState !== "published" && <p role="alert"
          className="m-0 rounded-2xl bg-red-wash px-3 py-2 text-caption text-red-ink">
          This recipe revision is {recipe.publicationState}. {recipe.withdrawalReason ?? "Choose another recipe for a new plan."}</p>}
        {recipe.eligibility.status !== "eligible" && <div role="alert" className={`rounded-2xl px-3 py-2 text-caption ${
          recipe.eligibility.status === "blocked" ? "bg-red-wash text-red-ink" : "bg-yellow-wash text-yellow-ink"}`}>
          <p className="m-0 font-medium">{recipe.eligibility.status === "blocked" ? "This recipe conflicts with your rules." : "This recipe needs a rule check."}</p>
          <ul className="m-0 list-disc pl-5">{recipe.eligibility.reasons.map((reason, index) =>
            <li key={`${reason.code}-${index}`}>{reason.ingredientSeq === undefined ? "" : `Ingredient ${reason.ingredientSeq}: `}{reason.message}</li>)}</ul>
        </div>}
        {!complete && <p className="m-0 text-caption text-graphite">{recipe.source.rightsKind === "link_only"
          ? "Full text is available at the source link only." : "Ingredients or method missing. Find a complete recipe before planning."}</p>}
        <RecipeDetails recipe={recipe} titled={false} date={placement?.initialDate}
          showRuleMark={!alertStatesMark(recipe, ruleMark)} actions={hasActions ? <div role="group" aria-label={`${recipe.name} actions`}
          className="flex flex-col gap-2">
          {placement && <PutInMeal recipe={recipe} disabled={!plannable} {...placement} />}
          {(actions.onFavorite || actions.onFit) && <div className="flex flex-wrap gap-2">
            {/* Basis auto, so two labels that do not fit side by side wrap to two full rows rather
                than squeezing (a Button's label never wraps). */}
            {actions.onFavorite && <Button aria-pressed={favorite} disabled={busy !== null} className="flex-auto"
              onClick={() => void run("favorite", actions.onFavorite)}>{favorite ? "Remove saved recipe" : "Save recipe"}</Button>}
            {actions.onFit && <Button disabled={!plannable || busy !== null} className="flex-auto"
              onClick={() => void run("fit", actions.onFit)}>Adjust portion</Button>}
          </div>}
          {(placement || actions.onFit) && !plannable && <p className="m-0 text-tiny text-muted">{rulesChanged
            ? "Your Avoid list changed. Search again before planning this recipe."
            : "A fit preview needs complete energy and macro values plus an eligible published recipe. Estimates remain approximate."}</p>}
          {busy === "fit" && <Thinking size="inline" label="Preparing preview…" />}
          <AnimatePresence initial={false}>
            {fitPanel && <Fold key="fit">{fitPanel}</Fold>}
          </AnimatePresence>
          {busy === "favorite" && <p role="status" className="m-0 text-caption text-graphite">Saving favorite…</p>}
          {error && <p role="alert" className="m-0 text-caption text-alert">{error}</p>}
        </div> : undefined} />
      </div>}
    </div>
  </article>;
}
