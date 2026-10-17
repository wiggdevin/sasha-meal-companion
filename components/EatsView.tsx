import FavoritesStrip from "@/components/FavoritesStrip";
import CatalogFavorites from "@/components/CatalogFavorites";
import OpenWorldInvitation from "@/components/foods/OpenWorldInvitation";
import EatenOften from "@/components/EatenOften";
import EatsFoods from "@/components/MyFoods";
import RecipesSection from "@/components/RecipesSection";
import { LIST_LIMIT } from "@/components/MyFoods.list";
import type { RecipeAccess } from "@/lib/recipe-access-client";

/**
 * Everything the account can eat, in the order it is reached for: favorites, the account's own
 * list, then saved recipes. Nothing here mentions an avoided food.
 */


export default function EatsView({ recipeAccess = { enabled: false, loading: false } }: {
  recipeAccess?: Pick<RecipeAccess, "enabled" | "loading"> & Partial<Pick<RecipeAccess, "unavailable" | "retry">>;
}) {
  return (
    <>
      <OpenWorldInvitation />
      <section aria-label="Favorites">
        <FavoritesStrip limit={LIST_LIMIT} />
        {recipeAccess.enabled && <CatalogFavorites />}
      </section>
      <p className="ground-muted m-0 text-sm">Favorites help rank recipes. Foods on Avoid stay out of recommendations.</p>
      <h2 className="font-display m-0 text-heading-sm leading-heading-sm text-charcoal">Your usual foods</h2>
      <EatsFoods />
      <EatenOften />
      <RecipesSection recipeAccess={recipeAccess} />
    </>
  );
}
