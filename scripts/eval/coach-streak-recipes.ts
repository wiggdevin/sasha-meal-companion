import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Fixture } from "@/tests/log/fixtures";
import { STREAK_FOODS } from "./coach-streak-foods";

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

/** Two no-cook recipes, so "recipes I can make without cooking" has something to offer. */
const RECIPES = [
  { name: "Tuna and avocado bowl", servings: 1,
    items: [["streak-tuna", 100], ["streak-avocado", 80], ["streak-rice", 150]] },
  { name: "Banana and egg-white plate", servings: 1,
    items: [["streak-banana", 120], ["streak-egg-whites", 150]] },
] as const;

export async function seedRecipes(
  db: SupabaseClient, userId: string, fixtures: Map<string, Fixture>,
): Promise<void> {
  for (const recipe of RECIPES) {
    const lines = recipe.items.map(([sourceId, grams]) => {
      const fixture = fixtures.get(sourceId);
      const food = STREAK_FOODS.find((candidate) => candidate.sourceId === sourceId);
      if (!fixture || !food) throw new Error(`Data setup failed: ${sourceId} fixture is missing.`);
      return { fixture, food, grams };
    });
    const sum = (key: string) => Math.round(lines.reduce(
      (total, line) => total + (line.food.per100g[key] ?? 0) * line.grams / 100, 0) * 10) / 10;
    const recipeId = randomUUID();
    const revisionId = randomUUID();
    must("recipes", (await db.from("recipes").insert({
      id: recipeId, user_id: userId, name: recipe.name, servings: recipe.servings, rev: 1,
    })).error);
    must("recipe_revisions", (await db.from("recipe_revisions").insert({
      id: revisionId, recipe_id: recipeId, rev: 1,
      nutrients_per_serving: {
        energy_kcal: { amount: sum("energy_kcal") }, protein: { amount: sum("protein") },
        carbohydrate: { amount: sum("carbohydrate") }, fat_total: { amount: sum("fat_total") },
      },
    })).error);
    must("recipe_items", (await db.from("recipe_items").insert(lines.map((line, index) => ({
      recipe_revision_id: revisionId, seq: index + 1, qty: line.grams, unit: "g",
      food_ref_id: line.fixture.foodRefId, food_revision_id: line.fixture.revisionId,
      grams: line.grams,
    })))).error);
  }
}
