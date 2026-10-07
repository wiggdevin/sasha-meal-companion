"use client";

import RecipeItemRow from "@/components/RecipeItemRow";
import { MacroFigure } from "@/components/nutrition/MacroText";
import { servingBound } from "@/lib/nutrition-display";
import { servingGrams } from "@/lib/recipes/nutrients";
import type { RecipeStrip } from "@/lib/recipes/use-recipe-sheet";
import type { RecipeDraft } from "@/lib/recipes/recipe-sheet-state";

type Strip = RecipeStrip | null;

/**
 * The blank row that ends the list (FluidVoice A07): shaped like an ingredient row, with the
 * stepper's minus and plus as quiet edges and muted copy between them. It only opens the picker;
 * the draft changes when a food is picked there.
 */
function AddIngredientRow({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="shell">
      <button type="button" onClick={onAdd} aria-label="Add ingredient"
        className="surface tap flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl! px-3.5 py-3 text-muted">
        <span data-edge="minus" aria-hidden="true" className="flex w-11 justify-center">−</span>
        <span className="text-caption font-normal">Add ingredient</span>
        <span data-edge="plus" aria-hidden="true" className="flex w-11 justify-center">+</span>
      </button>
    </div>
  );
}

/** The "N items · X g" line with the provisional strip, then one row per ingredient. */
export default function RecipeDraftList({ items, totalGrams, servings, yieldGrams, strip,
  stripError, onGrams, onRemove, onAddIngredient }: {
  items: RecipeDraft[]; totalGrams: number; servings: number; yieldGrams: number | null;
  strip: Strip; stripError: string | null;
  onGrams: (index: number, grams: number) => void; onRemove: (index: number) => void;
  onAddIngredient: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-1.5">
        <span className="text-tiny font-normal text-graphite">
          {items.length === 0 ? "Add what goes in it" : `${items.length} items · ${totalGrams} g`}
        </span>
        {/* A failed total replaces the strip rather than leaving the last number standing. */}
        {stripError ? (
          <span className="text-tiny text-alert" role="status">{stripError}</span>
        ) : strip && (
          // #21: a partly measured serving is a lower bound ("at least …"); an unknown kcal shows none.
          <span className="tabular-nums text-tiny font-normal text-muted" data-serving-strip="">
            {strip.kcal !== null && <><MacroFigure macro="kcal" value={strip.kcal}
              bound={servingBound(strip.nutritionComplete)} />{" a serving · "}</>}
            {servingGrams(totalGrams, servings, yieldGrams ?? undefined)} g{strip.kcal === null && " a serving"}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2" data-ingredient-rows>
        {items.map((item, i) => (
          <RecipeItemRow key={`${item.foodRefId}-${item.seq}`} item={item} name={item.name}
            onGrams={(grams) => onGrams(i, grams)} onRemove={() => onRemove(i)} />
        ))}
        <AddIngredientRow onAdd={onAddIngredient} />
      </div>
    </>
  );
}
