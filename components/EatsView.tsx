import CatalogFavorites from "@/components/CatalogFavorites";
import OpenWorldInvitation from "@/components/foods/OpenWorldInvitation";
import EatenOften from "@/components/EatenOften";
import EatsFoods from "@/components/MyFoods";
import RecipesSection from "@/components/RecipesSection";
import type { RecipeAccess } from "@/lib/recipe-access-client";

/**
 * The Foods first tab (UI makeover §6): the Preferred shopping list, what the account eats often,
 * then saved recipes. Both lists are grouped by aisle. Nothing here mentions an avoided food.
 */
export default function EatsView({ recipeAccess = { enabled: false, loading: false } }: {
  recipeAccess?: Pick<RecipeAccess, "enabled" | "loading"> & Partial<Pick<RecipeAccess, "unavailable" | "retry">>;
}) {
  return (
    <>
      <OpenWorldInvitation />
      <section aria-label="Favorites" className="flex flex-col gap-3">
        <EatsFoods shopping={recipeAccess.enabled} />
        {recipeAccess.enabled && <CatalogFavorites />}
      </section>
      <EatenOften />
      <RecipesSection recipeAccess={recipeAccess} />
    </>
  );
}
