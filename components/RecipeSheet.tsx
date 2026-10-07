"use client";

import RecipeDraftList from "@/components/RecipeDraftList";
import RecipeIngredientPicker from "@/components/RecipeIngredientPicker";
import Sheet from "@/components/Sheet";
import Stepper from "@/components/Stepper";
import { useRecipeSheet } from "@/lib/recipes/use-recipe-sheet";
import type { RecipeRow } from "@/lib/recipes-client";
import { deleteRecipe } from "@/lib/recipes-client";
import { currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { useRef, useState } from "react";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";

/** Phase 3 spec, "Client changes": editing shows "saving creates version N+1". */
export function nextVersionCopy(rev: number): string {
  return `Saving creates version ${rev + 1}.`;
}

export default function RecipeSheet({ recipe, onClose, onSaved, onDeleted }: {
  recipe?: RecipeRow; onClose: () => void;
  onSaved: (result: { recipeId: string; rev: number }) => void;
  onDeleted?: () => void;
}) {
  const openingAccount = useRef(currentAccountOrNull());
  const accountStillOpen = () => openingAccount.current !== null && isCurrent(openingAccount.current);
  const sheet = useRecipeSheet({ recipe, onSaved: (result) => { if (accountStillOpen()) onSaved(result); } });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A new recipe opens on the ingredient search; an edit opens on its list, and the Add ingredient
  // row switches to the same search.
  const [picking, setPicking] = useState(() => !recipe);

  return (
    <Sheet title={recipe ? "Edit recipe" : "New recipe"}
      subtitle={nextVersionCopy(recipe?.rev ?? 0)} onClose={onClose}
      footer={<div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" block disabled={!sheet.canSave}
          status={sheet.saving ? "pending" : undefined}
          onClick={() => {
            if (!accountStillOpen()) { setDeleteError("Account changed. Reopen this recipe."); return; }
            void sheet.save();
          }}>
          Save recipe
        </Button>
        {/* Remove is two steps (DESIGN.md §Buttons, danger): the confirm fills red (data-armed). */}
        {recipe && onDeleted && (confirmDelete ? <div className="flex items-center gap-2">
          <Button variant="tertiary" className="flex-1" disabled={deleting} onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" className="flex-1" data-armed="true" status={deleting ? "pending" : undefined}
            onClick={() => {
              if (!accountStillOpen()) { setDeleteError("Account changed. Reopen this recipe."); return; }
              setDeleting(true); setDeleteError(null);
              void deleteRecipe(recipe).then(() => { if (accountStillOpen()) onDeleted(); }, (cause: unknown) => {
                if (accountStillOpen()) setDeleteError(cause instanceof Error ? cause.message : "Could not remove recipe.");
              }).finally(() => setDeleting(false));
            }}>Confirm remove</Button>
        </div> : <Button variant="danger" block onClick={() => setConfirmDelete(true)}>Remove recipe</Button>)}
        {deleteError && <Notice tone="error" title={deleteError} />}
      </div>}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="pl-1.5 text-tiny font-normal text-graphite">Recipe name</span>
          <input value={sheet.name} onChange={(e) => sheet.setName(e.target.value)} aria-label="Recipe name"
            placeholder="Rice and chicken tray"
            className="well h-12 px-4 text-body-sm font-normal text-charcoal outline-none placeholder:text-muted" />
        </label>
        <Stepper label="Servings" value={sheet.servings} step={1}
          onChange={(next) => sheet.setServings(Math.max(1, next))} />
        <Stepper label="Cooked weight" value={sheet.yieldGrams ?? 0} step={50} unit="g"
          helperText="Optional — only needed to turn “I ate 150 g” into a serving fraction."
          onChange={(next) => sheet.setYieldGrams(next <= 0 ? null : next)} />

        <RecipeDraftList items={sheet.items} totalGrams={sheet.totalGrams} servings={sheet.servings}
          yieldGrams={sheet.yieldGrams} strip={sheet.strip} stripError={sheet.stripError}
          onGrams={sheet.setGrams} onRemove={sheet.remove} onAddIngredient={() => setPicking(true)} />

        {picking ? (
          <RecipeIngredientPicker useCatalog={sheet.useCatalog} query={sheet.query}
            notice={sheet.notice} onQuery={sheet.setQuery} onPickBundled={sheet.pickBundled}
            onPickCatalog={sheet.pickCatalog} />
        ) : sheet.notice && (
          // The picker owns this line when it is open; closed, a failed save still says why.
          <Notice tone="attention" title={sheet.notice} />
        )}
      </div>
    </Sheet>
  );
}
