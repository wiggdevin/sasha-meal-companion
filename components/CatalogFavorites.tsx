"use client";

import { useEffect, useState } from "react";
import { assertCurrent, currentAccountOrNull, onAccountGone, onAccountReady,
  type AccountHandle } from "@/lib/device/account";
import { listCatalogFavorites, type CatalogFavoriteRow } from "@/lib/recipe-catalog-client";
import { setCatalogFavorite } from "@/lib/recipe-catalog-client";
import CappedList from "@/components/MyFoods.list";
import Notice from "@/components/ui/Notice";

export default function CatalogFavorites() {
  const [account, setAccount] = useState<AccountHandle | null>(() => currentAccountOrNull());
  const [rows, setRows] = useState<CatalogFavoriteRow[]>([]);
  const [error, setError] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    const ready = onAccountReady(setAccount);
    const gone = onAccountGone(() => { setAccount(null); setRows([]); setError(false); });
    return () => { ready(); gone(); };
  }, []);
  useEffect(() => {
    if (!account) return;
    let live = true;
    const reload = () => { void listCatalogFavorites().then((favorites) => {
      if (live) { assertCurrent(account); setRows(favorites); setError(false); }
    }).catch(() => { if (live) setError(true); }); };
    reload();
    window.addEventListener("catalog-favorite-changed", reload);
    return () => { live = false; window.removeEventListener("catalog-favorite-changed", reload); };
  // The account epoch is the stable subscription key; accountHandle returns a fresh object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.epoch]);
  if (!rows.length && !error) return null;
  const chip = (row: CatalogFavoriteRow) => row.withdrawn ? <span className="pill flex items-center gap-2 px-3 py-2 text-sm">
    {row.name} · source withdrawn
    <button type="button" className="tap underline" disabled={removing !== null}
      onClick={() => {
        if (!account) return;
        setRemoving(row.recipeId);
        void setCatalogFavorite(row.recipeId, false, row.revision).then(() => {
          assertCurrent(account);
          setRows((current) => current.filter((item) => item.recipeId !== row.recipeId));
          window.dispatchEvent(new Event("catalog-favorite-changed"));
        }).catch(() => setError(true)).finally(() => setRemoving(null));
      }}>Unfavorite</button>
  </span> : <button type="button"
    onClick={() => {
      window.dispatchEvent(new CustomEvent("catalog-recipe-open", { detail: row.recipeId }));
      document.getElementById("discover-recipes")?.scrollIntoView();
    }} className="pill tap min-h-11 px-3 py-2 text-sm">{row.name}</button>;
  // At most six chips, then "Show all N" opens the rest in place (MyFoods.list.tsx).
  return <div className="flex flex-col gap-2" aria-label="Favorite shared recipes">
    <CappedList items={rows} keyOf={(row) => row.recipeId} className="flex flex-wrap gap-2"
      label="shared recipe favorites" render={chip} />
    {error && <Notice tone="error" title="Shared recipe favorites could not load." />}
  </div>;
}
