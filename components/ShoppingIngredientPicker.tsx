"use client";

import { useEffect, useState } from "react";
import GlassSelect from "@/components/ui/GlassSelect";
import SearchField from "@/components/ui/SearchField";
import { listFavorites } from "@/lib/favorites-client";
import { FOOD_DB, searchFoods } from "@/lib/food-db";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import { identityKey } from "@/lib/shopping/aggregate";
import type { IngredientIdentity, PantryItem, ShoppingLine } from "@/lib/shopping/types";
import RuleMark from "@/components/ui/RuleMark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";
import { worseRuleMark } from "@/lib/rule-mark";

export type IngredientOption = { name: string; identity: IngredientIdentity; source: "favorite" | "list" | "pantry" | "search";
  /** The server's mark on the list line or pantry item it came from; favorites and search have none. */
  ruleMark?: RuleMarkValue | null };
const dbByName = new Map(FOOD_DB.map((food) => [food.name.toLowerCase(), food]));
function dbIdentity(id: string, state: IngredientIdentity["purchaseState"] = "raw"): IngredientIdentity {
  return { foodRefId: null, foodDbId: id, catalogFoodRevisionId: null,
    purchaseState: state, variantKey: state };
}
export function favoriteIngredientOption(row: { kind: string; name: string; foodRefId?: string;
  revisionId?: number | null }): IngredientOption | null {
  if (row.kind !== "food" || row.name === "Saved food") return null;
  const db = dbByName.get(row.name.toLowerCase());
  if (db) return { name: row.name, identity: dbIdentity(db.id), source: "favorite" };
  if (!row.foodRefId) return null;
  return { name: row.name, identity: { foodRefId: row.foodRefId, foodDbId: null,
    catalogFoodRevisionId: row.revisionId ?? null, purchaseState: "as_purchased",
    variantKey: "as_purchased" }, source: "favorite" };
}

/** Basket selection is a planning preference. It never creates a favorite or confirms stock. */
export default function ShoppingIngredientPicker({ lines, pantry, selected, onChange }: {
  lines: ShoppingLine[]; pantry: PantryItem[]; selected: IngredientIdentity[];
  onChange: (next: IngredientIdentity[]) => void;
}) {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [favorites, setFavorites] = useState<IngredientOption[]>([]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<IngredientIdentity["purchaseState"]>("raw");
  const [error, setError] = useState(false);
  useEffect(() => {
    const ready = onAccountReady((next) => {
      setAccount(next); setFavorites([]); setQuery(""); setState("raw"); setError(false);
    });
    const gone = onAccountGone(() => {
      setAccount(null); setFavorites([]); setQuery(""); setState("raw"); setError(false);
    });
    return () => { ready(); gone(); };
  }, []);
  useEffect(() => {
    if (!account) return;
    let live = true;
    void listFavorites().then((rows) => {
      if (live && currentAccountOrNull()?.epoch === account.epoch) {
        setFavorites(rows.flatMap((row) => { const option = favoriteIngredientOption(row);
          return option ? [option] : []; })); setError(false);
      }
    }).catch(() => { if (live && currentAccountOrNull()?.epoch === account.epoch) setError(true); });
    return () => { live = false; };
  }, [account]);
  const current: IngredientOption[] = lines.flatMap((line) => line.identity
    ? [{ name: line.name, identity: line.identity, source: "list" as const, ruleMark: line.ruleMark ?? null }] : []);
  const stocked: IngredientOption[] = pantry.flatMap((item) => item.confirmedGrams !== null
    && item.confirmedGrams > 0 ? [{ name: item.name, identity: item.identity, source: "pantry" as const,
      ruleMark: item.ruleMark ?? null }] : []);
  const searched: IngredientOption[] = query.trim() ? searchFoods(query.trim(), {}, 12)
    .filter((hit) => hit.source === "db")
    .map((hit) => ({ name: hit.name, identity: dbIdentity(hit.id, state), source: "search" })) : [];
  const unique = new Map<string, IngredientOption>();
  // The first option for an identity wins, but never hides a worse rule mark from a later one
  // (a list line and a pantry item can share an identity and be judged differently).
  for (const option of [...current, ...stocked, ...favorites, ...searched]) {
    const key = identityKey(option.identity);
    const kept = unique.get(key);
    unique.set(key, kept ? { ...kept, ruleMark: worseRuleMark(kept.ruleMark, option.ruleMark) } : option);
  }
  const selectedKeys = new Set(selected.map(identityKey));
  function toggle(identity: IngredientIdentity, checked: boolean) {
    const key = identityKey(identity);
    onChange(checked ? [...selected.filter((item) => identityKey(item) !== key), identity]
      : selected.filter((item) => identityKey(item) !== key));
  }
  return <section className="shell" aria-label="Choose plan ingredients"><div className="surface flex flex-col gap-3 p-4">
    <h2 className="m-0 text-base font-semibold">Choose ingredients for this plan</h2>
    <p className="ground-muted m-0 text-sm">Favorites, the current list and confirmed pantry are suggestions. Selecting one does not say you own it.</p>
    <label className="flex flex-col gap-1 text-sm">Search foods
      <SearchField value={query} onValueChange={setQuery} label="Search foods" placeholder="e.g. chicken, rice" /></label>
    {query && <div className="flex flex-col gap-1 text-sm">Purchase state
      <GlassSelect aria-label="Purchase state" value={state}
        onChange={(value) => setState(value as IngredientIdentity["purchaseState"])}
        options={[{ value: "raw", label: "Raw" }, { value: "as_purchased", label: "As purchased" },
          { value: "cooked", label: "Cooked" }, { value: "ready_to_eat", label: "Ready to eat" }]} />
    </div>}
    {error && <p role="alert" className="m-0 text-sm text-alert">Favorites could not load. You can still search foods.</p>}
    {[...unique].map(([key, option]) => <label key={key} className="flex min-h-11 items-center gap-3 text-sm">
      <input type="checkbox" checked={selectedKeys.has(key)}
        onChange={(event) => toggle(option.identity, event.target.checked)} />
      <span className="min-w-0">{option.name} <span className="ground-muted">· {option.source}</span>
        {option.ruleMark && <> <RuleMark mark={option.ruleMark} variant="tag" className="align-middle" /></>}</span>
    </label>)}
    {query && searched.length === 0 && <p className="ground-muted m-0 text-sm">No canonical food matched. Try another name.</p>}
  </div></section>;
}
