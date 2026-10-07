"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecipeCandidate, RecipeSearch } from "@/lib/recipe-catalog/types";
import { accountFetch, accountHandle, accountJson, assertCurrent } from "@/lib/device/account";
import { withRecipeRuleMark } from "@/lib/recipes/rule-mark-wire";
import { judgedRulesKey } from "@/lib/recipes/recipe-freshness";

/** Transport is supplied by the route adapter so the hook never guesses a wire shape. */
export type RecipeSearchResponse = { recipes: RecipeCandidate[]; count: number; limitations: string[];
  /** The normalized diet flags each `recipes[].ruleMark` was judged under. */
  ruleFlags?: string[];
  /**
   * False when no recipe carries every searched word: `recipes` is the closest matches, not an
   * exact one ("No exact match, closest recipes"). Optional for a server or fixture that omits it.
   */
  exactMatch?: boolean };
export class RecipeSearchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "RecipeSearchError"; }
}
export type RecipeCatalogReader = (query: RecipeSearch, signal: AbortSignal) => Promise<RecipeSearchResponse>;
export type RecipeCatalogState = {
  recipes: RecipeCandidate[];
  limitations: string[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  retry: () => void;
};

export function useRecipeCatalog(scopeKey: string, query: RecipeSearch | null,
  read: RecipeCatalogReader): RecipeCatalogState {
  const [result, setResult] = useState<{ key: string; attempt: number; recipes: RecipeCandidate[];
    status: "ready" | "error"; error: string | null; limitations: string[] }>({
    key: "", attempt: -1, recipes: [], limitations: [], status: "ready", error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const key = JSON.stringify([scopeKey, query]);
  useEffect(() => {
    const parsed = JSON.parse(key) as [string, RecipeSearch | null];
    if (!parsed[1]) return;
    const controller = new AbortController();
    const current = ++request.current;
    void read(parsed[1], controller.signal).then((response) => {
      if (current !== request.current || controller.signal.aborted) return;
      setResult({ key, attempt, recipes: response.recipes, limitations: response.limitations, status: "ready", error: null });
    }).catch((cause) => {
      if (current !== request.current || controller.signal.aborted) return;
      setResult({ key, attempt, recipes: [], limitations: [], status: "error",
        error: cause instanceof Error ? cause.message : "Recipes could not load." });
    });
    return () => { controller.abort(); request.current += 1; };
  }, [key, read, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  if (!query) return { recipes: [], limitations: [], status: "idle", error: null, retry };
  if (result.key !== key || result.attempt !== attempt)
    return { recipes: [], limitations: [], status: "loading", error: null, retry };
  return { recipes: result.recipes, limitations: result.limitations, status: result.status, error: result.error, retry };
}

/** Authenticated route reads use the bound account and the existing search deadline. */
export const searchCatalogRecipes: RecipeCatalogReader = async (query, signal) => {
  if (query.excludedFoodRefIds?.length) {
    throw new Error("Ingredient exclusions are not supported by this recipe search yet.");
  }
  const h = accountHandle();
  const params = new URLSearchParams({ q: query.query });
  if (query.cuisine) params.set("cuisine", query.cuisine);
  if (query.maxMinutes !== undefined) params.set("maxMinutes", String(query.maxMinutes));
  if (query.effort) params.set("effort", query.effort);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const res = await accountFetch(h, `/api/recipes?${params}`, { signal, cache: "no-store" }, { budget: "search" });
  if (!res.ok) {
    const body = await accountJson<{ error?: unknown; message?: unknown }>(h, res).catch(() => null);
    assertCurrent(h);
    const code = typeof body?.error === "string" ? body.error : "recipe_search_failed";
    const message = typeof body?.message === "string" && body.message !== "Something went wrong."
      ? body.message : res.status >= 500
        ? "Recipe search is unavailable right now. Try again shortly."
        : `Recipe search failed (${res.status}).`;
    throw new RecipeSearchError(code, message);
  }
  const body = await accountJson<RecipeSearchResponse>(h, res);
  // Each recipe's verdict under the current rules, parsed here so every surface reads one shape.
  // ...and the rules the server judged them under (its `ruleFlags`; a null fingerprint is unjudged).
  const ruleMarkRulesKey = judgedRulesKey(body);
  return Array.isArray(body?.recipes)
    ? { ...body, recipes: body.recipes.map((recipe) => ({ ...withRecipeRuleMark(recipe), ruleMarkRulesKey })) } : body;
};

/** A recipe detail read the server answered with an error status. 4xx other than 408/429 is its
 *  answer about that recipe; anything else (5xx, 408, 429, or no answer at all) is transient. */
export class RecipeReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "RecipeReadError"; }
  get transient(): boolean { return this.status >= 500 || this.status === 408 || this.status === 429; }
}

/** Whether a failed detail read may succeed if tried again (a network failure, a timeout, a 5xx). */
export function transientRecipeReadFailure(cause: unknown): boolean {
  return !(cause instanceof RecipeReadError) || cause.transient;
}

export async function getCatalogRecipe(recipeId: string, signal?: AbortSignal): Promise<RecipeCandidate> {
  const h = accountHandle();
  const res = await accountFetch(h, `/api/recipes/${encodeURIComponent(recipeId)}`,
    { signal, cache: "no-store" }, { budget: "search" });
  if (res.status === 410) throw new RecipeReadError("This recipe was withdrawn. Choose another for a new plan.", 410);
  if (!res.ok) throw new RecipeReadError(`Recipe could not load (${res.status}).`, res.status);
  const body = await accountJson<RecipeCandidate & { ruleFlags?: unknown }>(h, res);
  return { ...withRecipeRuleMark(body), ruleMarkRulesKey: judgedRulesKey(body) };
}

export type CatalogFavoriteState = { favorite: boolean; revision: number };
export type CatalogFavoriteRow = { recipeId: string; name: string; revision: number;
  sort: number; withdrawn: boolean };
export async function listCatalogFavorites(): Promise<CatalogFavoriteRow[]> {
  const h = accountHandle();
  const res = await accountFetch(h, "/api/recipes/favorites", { cache: "no-store" }, { budget: "prefs" });
  if (!res.ok) throw new Error(`Favorites could not load (${res.status}).`);
  return (await accountJson<{ favorites: CatalogFavoriteRow[] }>(h, res)).favorites;
}
export async function getCatalogFavorite(recipeId: string): Promise<CatalogFavoriteState> {
  const h = accountHandle();
  const res = await accountFetch(h, `/api/recipes/${encodeURIComponent(recipeId)}/favorite`,
    { cache: "no-store" }, { budget: "prefs" });
  if (!res.ok) throw new Error(`Favorite could not load (${res.status}).`);
  return accountJson<CatalogFavoriteState>(h, res);
}
export async function setCatalogFavorite(recipeId: string, favorite: boolean,
  expectedRevision: number | null): Promise<CatalogFavoriteState> {
  const h = accountHandle();
  const res = await accountFetch(h, `/api/recipes/${encodeURIComponent(recipeId)}/favorite`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ favorite, expectedRevision: expectedRevision === 0 ? null : expectedRevision,
      requestId: crypto.randomUUID() }),
  }, { budget: "prefs" });
  if (res.status === 409) throw new Error("Favorite changed elsewhere. Refresh and try again.");
  if (!res.ok) throw new Error(`Favorite could not save (${res.status}).`);
  return accountJson<CatalogFavoriteState>(h, res);
}
