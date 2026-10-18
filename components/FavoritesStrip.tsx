"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { currentAccountOrNull, onAccountGone, onAccountReady, type AccountHandle } from "@/lib/device/account";
import { listFavorites } from "@/lib/favorites-client";
import { FAVORITES_CHANGED_EVENT, pinnedAndRest, type FavoriteRow } from "@/lib/favorites";
import CappedList from "@/components/MyFoods.list";
import Button from "@/components/ui/Button";

/* A chip is the shared tertiary Button at its small size (2026-10-04 button system); a chip that
   navigates is a link drawn with the same classes. */
const CHIP = "btn btn-tertiary btn-sm";
/** A long food or recipe name wraps inside its chip instead of being clipped at 320 px. */
const WRAP = "h-auto max-w-full whitespace-normal py-1.5 text-left";

/** Where a chip goes when the host screen has no pick handler (the Foods tab). */
export function favoriteHref(row: FavoriteRow): string {
  if (row.kind === "recipe") return "/foods#recipes";
  if (row.kind === "food") return "/foods";
  return "/";
}

/** `listFavorites` reads three IndexedDB stores with no internal try/catch; a blocked/quota/
 *  private-mode failure would otherwise reject uncaught. Turn that into an explicit `null` so the
 *  caller can tell "no favorites yet" apart from "failed to load". */
export async function loadFavoritesForStrip(): Promise<FavoriteRow[] | null> {
  try {
    return await listFavorites();
  } catch {
    return null;
  }
}

/**
 * The favorites chips. With no `limit` it is the log sheet's one-line strip (twelve pinned, the rest
 * behind "All"). With `limit` (the Foods page) the chips wrap, and past the limit a "Show all N"
 * row opens the rest in place — no sideways scroll area (owner, 2026-10-04).
 */
export default function FavoritesStrip({ initial, onPick, limit }: {
  initial?: FavoriteRow[]; onPick?: (row: FavoriteRow) => void; limit?: number;
}) {
  const [rows, setRows] = useState<FavoriteRow[]>(initial ?? []);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /** Bumped by every read and every account change: only the latest read of this account lands. */
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    const reload = () => {
      // Stamped when it starts (audit b4b #1): a read that finishes after an account switch, or
      // after a newer read (the one a saved star fires), is dropped instead of painting stale chips.
      const account = currentAccountOrNull();
      const run = ++generation.current;
      void loadFavoritesForStrip().then((next) => {
        if (!live || run !== generation.current || !sameAccount(account, currentAccountOrNull())) return;
        if (next === null) { setFailed(true); return; }
        setFailed(false);
        setRows(next);
      });
    };
    reload();
    // A star on a Foods row lands here without a remount.
    window.addEventListener(FAVORITES_CHANGED_EVENT, reload);
    // The Foods page stays mounted across an account switch: the old account's names go at once.
    const offGone = onAccountGone(() => {
      generation.current += 1;
      setRows([]); setFailed(false); setShowAll(false);
    });
    const offReady = onAccountReady(reload);
    return () => {
      live = false;
      window.removeEventListener(FAVORITES_CHANGED_EVENT, reload);
      offGone(); offReady();
    };
  }, []);

  if (rows.length === 0) {
    if (!failed) return null;
    return (
      <div className="text-xs text-text-hint" aria-label="Favorites">
        Couldn&apos;t load favorites.
      </div>
    );
  }
  // With no pick handler a food chip has nowhere to go (its link would be the page it is on), so it
  // is a plain tag, not something that looks tappable and does nothing.
  const chip = (row: FavoriteRow) => onPick
    ? <Button variant="tertiary" size="sm" className={WRAP} onClick={() => onPick(row)}>{row.name}</Button>
    : row.kind === "food"
      ? <span className="pill inline-flex max-w-full items-center break-words px-3 py-1.5 text-caption text-graphite">
        {row.name}
      </span>
      : <Link href={favoriteHref(row)} className={`${CHIP} ${WRAP}`}>{row.name}</Link>;
  if (limit !== undefined) {
    const ordered = [...rows].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
    return (
      <div aria-label="Favorites">
        <CappedList items={ordered} limit={limit} keyOf={(row) => `${row.kind}:${row.id}`}
          className="flex flex-wrap gap-2 pb-1" label="favorites" render={(row) => chip(row)} />
      </div>
    );
  }
  const { pinned, rest } = pinnedAndRest(rows);
  const shown = showAll ? [...pinned, ...rest] : pinned;

  return (
    <div className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1" aria-label="Favorites">
      {shown.map((row) => <Fragment key={`${row.kind}:${row.id}`}>{chip(row)}</Fragment>)}
      {rest.length > 0 && !showAll && (
        <Button variant="tertiary" size="sm" onClick={() => setShowAll(true)}>All ({rows.length})</Button>
      )}
    </div>
  );
}

function sameAccount(a: AccountHandle | null, b: AccountHandle | null): boolean {
  return a === null ? b === null : b !== null && a.userId === b.userId && a.epoch === b.epoch;
}
