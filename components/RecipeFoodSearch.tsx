"use client";

import { useMemo } from "react";
import RecipeFoodRow from "@/components/RecipeFoodRow";
import SearchField from "@/components/ui/SearchField";
import { searchFoods, type SearchHit } from "@/lib/food-db";
import type { Food } from "@/lib/foods";

/**
 * The recipe sheet's ingredient search when the catalog is off (T1, 2026-09-12): the bundled
 * food list, the same one lib/food-db.ts feeds "Log a food". Off-plan foods are marked, never
 * hidden. A view only — the query lives in the sheet, so a row can be picked and the list redrawn.
 */
export default function RecipeFoodSearch({ query, mine, onQuery, onPick }: {
  query: string;
  mine: Record<string, Food>;
  onQuery: (query: string) => void;
  onPick: (hit: SearchHit) => void;
}) {
  const hits = useMemo(() => searchFoods(query, mine), [query, mine]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="pl-1.5 text-tiny font-normal text-graphite">Search foods</span>
        <SearchField value={query} onValueChange={onQuery} label="Search foods"
          placeholder="e.g. chicken, banana, chkn brst" />
      </label>

      {query.trim() !== "" && hits.length === 0 && (
        <p className="px-1.5 text-tiny text-muted" role="status">
          Nothing matches. Try fewer letters.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {hits.map((hit) => (
          <RecipeFoodRow key={`${hit.source}:${hit.id}`} hit={hit} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}
