import { redirect } from "next/navigation";

/**
 * Recipes are a section of the Foods tab now (2026-09-16). The route stays so an installed
 * home-screen shortcut, a bookmark or an old link still lands somewhere real.
 */
export default function RecipesPage() {
  redirect("/foods#recipes");
}
