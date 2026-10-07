"use client";

import { useEffect, useState } from "react";
import CatalogRecipeResults from "@/components/CatalogRecipeResults";
import GlassSelect from "@/components/ui/GlassSelect";
import { getCatalogRecipe, RecipeSearchError, searchCatalogRecipes } from "@/lib/recipe-catalog-client";
import { recipesJudgedNow, useRecipeReader } from "@/lib/recipes/recipe-freshness";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import type { RecipeCandidate, RecipeSearch } from "@/lib/recipe-catalog/types";
import Button from "@/components/ui/Button";
import Disclosure from "@/components/ui/Disclosure";
import Notice from "@/components/ui/Notice";
import SearchField from "@/components/ui/SearchField";

type Found = { recipes: RecipeCandidate[]; limitations: string[];
  /** False when no recipe carries every searched word: `recipes` is the closest match, not exact. */
  exactMatch: boolean };
type Filters = { cuisine: string; maxMinutes: string; effort: "any" | "none" | "minimal" };

export default function RecipeDiscovery({ initialDate, initialSlotId, onPlanned }: {
  initialDate?: string; initialSlotId?: string; onPlanned?: () => void;
} = {}) {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [resultEpoch, setResultEpoch] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [cuisine, setCuisine] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("");
  const [effort, setEffort] = useState<"any" | "none" | "minimal">("any");
  const [query, setQuery] = useState("");
  const [recipes, setRecipes] = useState<RecipeCandidate[]>([]);
  const [limitations, setLimitations] = useState<string[]>([]);
  // False when the last landed search found no exact match: "No exact match, closest recipes".
  const [exactMatch, setExactMatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Whether the last search carried a filter, so an empty answer can offer to drop them.
  const [filtered, setFiltered] = useState(false);
  // One reader (lib/recipes/recipe-freshness.ts): a search or an opened favorite aborts the read
  // before it and only the newest lands; a rule change reads the shown results again.
  const { reader, stale } = useRecipeReader<Found>({
    apply: (result) => {
      setRecipes(result.recipes); setLimitations(result.limitations); setExactMatch(result.exactMatch);
      setResultEpoch(currentAccountOrNull()?.epoch ?? null);
    },
    judged: (result) => recipesJudgedNow(result.recipes),
  });
  /** A read for the account bound when it was asked: one that lands after a switch never applies. */
  const forAccount = (h: AccountHandle, load: (signal: AbortSignal) => Promise<Found>) => (signal: AbortSignal) =>
    load(signal).then((result) => {
      if (currentAccountOrNull()?.epoch !== h.epoch) throw new Error("Account changed.");
      return result;
    });
  useEffect(() => {
    const clear = () => {
      reader.clear();
      setRecipes([]); setLimitations([]); setExactMatch(true); setQuery(""); setDraft(""); setResultEpoch(null);
      setBusy(false); setError(null); setErrorCode(null);
    };
    const ready = onAccountReady((next) => { clear(); setAccount(next); });
    const gone = onAccountGone(() => { clear(); setAccount(null); });
    return () => { ready(); gone(); };
  }, [reader]);
  useEffect(() => {
    const open = (event: Event) => {
      const recipeId = (event as CustomEvent<unknown>).detail;
      if (typeof recipeId !== "string" || !account) return;
      setBusy(true); setError(null);
      void reader.read(forAccount(account, (signal) => getCatalogRecipe(recipeId, signal)
        .then((recipe) => ({ recipes: [recipe], limitations: [], exactMatch: true })))).then((outcome) => {
        if (outcome.status === "superseded") return;
        setBusy(false);
        if (outcome.status === "failed") {
          setError(outcome.error instanceof Error ? outcome.error.message : "Favorite recipe could not load.");
          return;
        }
        const name = outcome.value.recipes[0]?.name ?? "";
        setDraft(name); setQuery(name);
      });
    };
    window.addEventListener("catalog-recipe-open", open);
    return () => window.removeEventListener("catalog-recipe-open", open);
  }, [account, reader]);
  /**
   * The one search path: the form's submit (Enter, or the keyboard's Search key) lands here. The
   * field is the shared lookup field (input tier 1, 2026-10-04): a magnifier and a clear, no send.
   * `filters` lets Reset search with the cleared values before React has re-rendered them.
   */
  async function submitSearch(filters: Filters = { cuisine, maxMinutes, effort }) {
    const { cuisine, maxMinutes, effort } = filters;
    if (!account) return;
    if (maxMinutes.trim() && (!Number.isSafeInteger(Number(maxMinutes)) || Number(maxMinutes) < 1)) {
      setError("Max minutes must be a whole number of at least 1.");
      setErrorCode(null);
      return;
    }
    const next = draft.trim();
    setBusy(true); setError(null); setErrorCode(null); setQuery(next || "All recipes");
    setRecipes([]); setExactMatch(true); setResultEpoch(null);
    setFiltered(Boolean(cuisine.trim() || maxMinutes.trim() || effort !== "any"));
    const search: RecipeSearch = { query: next, limit: 3,
      ...(cuisine.trim() ? { cuisine: cuisine.trim() } : {}),
      ...(maxMinutes ? { maxMinutes: Number(maxMinutes) } : {}),
      ...(effort !== "any" ? { effort } : {}),
    };
    const outcome = await reader.read(forAccount(account, (signal) => searchCatalogRecipes(search, signal)
      .then((response) => ({ recipes: response.recipes, limitations: response.limitations,
        exactMatch: response.exactMatch ?? true }))));
    if (outcome.status === "superseded") return;
    setBusy(false);
    if (outcome.status === "failed") {
      const cause = outcome.error;
      setError(cause instanceof Error ? cause.message : "Recipes could not load.");
      setErrorCode(cause instanceof RecipeSearchError ? cause.code : null);
    }
  }
  function resetFilters() {
    const cleared: Filters = { cuisine: "", maxMinutes: "", effort: "any" };
    setCuisine(cleared.cuisine); setMaxMinutes(cleared.maxMinutes); setEffort(cleared.effort);
    void submitSearch(cleared);
  }
  const showResults = query && !busy && !error && resultEpoch === account?.epoch;
  const reset = <Button variant="ghost" size="sm" className="-ml-3 self-start" onClick={resetFilters}>Reset filters</Button>;
  return <section id="discover-recipes" className="flex flex-col gap-3" aria-label="Find recipes">
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submitSearch(); }}>
      <SearchField size="lg" value={draft} onValueChange={setDraft} label="Recipe dish or ingredient"
        placeholder="Dish or ingredient" aria-busy={busy || undefined} />
      {busy && <p role="status" className="ground-muted m-0 px-1 text-sm">Finding recipes…</p>}
    <Disclosure variant="row" size="sm" title="Recipe filters" bodyClassName="pb-2 text-sm">
      <div>
      <div data-filter-row className="grid grid-cols-3 gap-2">
        <label className="min-w-0 text-sm">Cuisine<input className="well mt-1 min-h-11 w-full min-w-0 px-2" value={cuisine}
          onChange={(event) => setCuisine(event.target.value)} /></label>
        <label className="min-w-0 text-sm">Max minutes<input type="number" min="1" className="well mt-1 min-h-11 w-full min-w-0 px-2"
          value={maxMinutes} onChange={(event) => setMaxMinutes(event.target.value)} /></label>
        <div className="min-w-0 text-sm"><span>Cooking effort</span><GlassSelect aria-label="Cooking effort" className="mt-1"
          value={effort} onChange={(value) => setEffort(value as typeof effort)}
          options={[{ value: "any", label: "Any" }, { value: "none", label: "No cooking" }, { value: "minimal", label: "Minimal" }]} /></div>
      </div>
      <p className="ground-muted m-0 text-sm">Avoided foods stay out of recipe results.</p>
      </div>
    </Disclosure>
    </form>
    {error && <Notice tone="error" title={error} />}
    {errorCode === "rule_review_required" && <a href="/foods#avoids" className="tap min-h-11 self-start text-sm underline">Review food rules in Avoids</a>}
    {errorCode === "conflicting_filters" && reset}
    {/* An empty filtered answer is not an error: it says so and offers the way back out. */}
    {showResults && filtered && recipes.length === 0 ? <div className="flex flex-col gap-2">
      <Notice tone="neutral" title="No recipes match these filters. Reset them to see every recipe your rules allow." />
      {limitations.length > 0 && <ul className="ground-muted m-0 list-disc pl-5 text-sm">
        {limitations.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      {reset}
    </div> : showResults && <div className="flex flex-col gap-2">
      {/* O4a: ranking never filters, so a search with no exact match still shows its closest recipes. */}
      {!exactMatch && recipes.length > 0 && <Notice tone="neutral" title="No exact match, closest recipes" />}
      <CatalogRecipeResults stale={stale}
        blockId={`foods:${query}`} sourceEpoch={resultEpoch} recipes={recipes} limitations={limitations}
        initialDate={initialDate} initialSlotId={initialSlotId} onPlanned={onPlanned} />
    </div>}
  </section>;
}
