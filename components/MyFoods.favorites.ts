"use client";

import { useEffect, useRef, useState } from "react";
import type { Food } from "@/lib/foods";
import { FAVORITES_CHANGED_EVENT, type FavoriteRow } from "@/lib/favorites";
import { listFavorites, setFavorite } from "@/lib/favorites-client";
import { foodRefsFor, readPrefRefCache } from "@/lib/foods/prefs-client";
import { accountHandle, assertCurrent, currentAccountOrNull, isCurrent, onAccountGone,
  onAccountReady } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";

type Refs = { userRefId: string; catalogRefId?: string };

/**
 * Starring a food from its Foods row (owner, 2026-10-04). It uses the one favourites mechanism the
 * Favorites strip already reads — `favorites_foods`, keyed by the food's ref, written through
 * `toggleFavorite` and the sync outbox — so a star here is the same star everywhere.
 *
 * Optimistic: the glyph fills at once, and a failure puts it back with a plain error line. One
 * toggle per food at a time; a second tap while the first is saving is ignored.
 *
 * Every read is stamped with the account and a generation when it starts (audit b4b #1): a read
 * that finishes after an account switch, or after a newer read or a star that already saved, is
 * dropped, so it can neither paint the old account's stars nor undo a star the user just set.
 */
export function useFoodFavorites() {
  /** The starred food refs, or null before the first read. */
  const [starred, setStarred] = useState<Set<string> | null>(null);
  /** Per food id, the state shown while its toggle is in flight. */
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  /** Refs resolved on this screen, for foods the ref cache did not know yet. */
  const [resolved, setResolved] = useState<Record<string, Refs>>({});
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  /** Bumped by every read, every saved star and every account change: only the latest read lands. */
  const generation = useRef(0);

  useEffect(() => {
    let live = true;
    const reload = () => {
      const h = currentAccountOrNull();
      if (!h) return;
      const run = ++generation.current;
      const fresh = () => live && run === generation.current && isCurrent(h);
      void listFavorites().then((rows) => {
        if (fresh()) setStarred(foodRefs(rows));
      }).catch(() => { if (fresh()) setStarred((current) => current ?? new Set()); });
    };
    reload();
    window.addEventListener(FAVORITES_CHANGED_EVENT, reload);
    window.addEventListener(SYNCED_EVENT, reload);
    const offGone = onAccountGone(() => {
      generation.current += 1;
      setStarred(null); setOptimistic({}); setResolved({}); setError(null); inFlight.current.clear();
    });
    const offReady = onAccountReady(reload);
    return () => {
      live = false;
      window.removeEventListener(FAVORITES_CHANGED_EVENT, reload);
      window.removeEventListener(SYNCED_EVENT, reload);
      offGone(); offReady();
    };
  }, []);

  function refsOf(food: Food): Refs | undefined {
    if (resolved[food.id]) return resolved[food.id];
    const h = currentAccountOrNull();
    const cached = h ? readPrefRefCache(h.userId)[food.id] : undefined;
    return cached?.userRefId ? { userRefId: cached.userRefId, catalogRefId: cached.catalogRefId } : undefined;
  }

  /** Which ref carries this food's star: its own, or a catalog ref starred elsewhere. */
  function starredRef(refs: Refs | undefined): string | null {
    if (!refs || !starred) return null;
    if (starred.has(refs.userRefId)) return refs.userRefId;
    return refs.catalogRefId && starred.has(refs.catalogRefId) ? refs.catalogRefId : null;
  }

  function isStarred(food: Food): boolean {
    if (food.id in optimistic) return optimistic[food.id];
    return starredRef(refsOf(food)) !== null;
  }

  /** Records `key`'s stored state, and drops any read that started before it was saved. */
  function settle(key: string, on: boolean) {
    generation.current += 1;
    setStarred((current) => {
      const next = new Set(current ?? []);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  async function toggle(food: Food): Promise<void> {
    if (inFlight.current.has(food.id)) return;
    const want = !isStarred(food);
    let h;
    try { h = accountHandle(); } catch { setError("Sign in to star a food."); return; }
    inFlight.current.add(food.id);
    setOptimistic((current) => ({ ...current, [food.id]: want }));
    setError(null);
    let key: string | null = null;
    try {
      const refs = refsOf(food) ?? await foodRefsFor(food, h);
      if (!refs) throw new Error("food refs unavailable");
      assertCurrent(h);
      key = want ? refs.userRefId : starredRef(refs) ?? refs.userRefId;
      setResolved((current) => ({ ...current, [food.id]: refs }));
      const meta = { name: food.name, catalogFoodId: food.catalogFoodId ?? null };
      // A set, not a toggle (audit b4b #10): a repeat, or a store that already holds this state,
      // lands the asked state once and never flips it back.
      const now = await setFavorite("food", key, want, meta, h);
      assertCurrent(h);
      if (now !== want) throw new Error("favorite did not change");
      settle(key, want);
      window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
    } catch {
      if (!isCurrent(h)) return;
      // Roll back only on a real failure: a write that landed but did not answer keeps its star.
      const stored = key === null ? null : await storedState(key);
      if (!isCurrent(h)) return;
      if (key !== null && stored !== null) settle(key, stored);
      if (stored !== want) {
        setError(want ? `Could not star ${food.name}. Try again.` : `Could not unstar ${food.name}. Try again.`);
      } else {
        window.dispatchEvent(new Event(FAVORITES_CHANGED_EVENT));
      }
    } finally {
      inFlight.current.delete(food.id);
      // Dropping the optimistic value shows the stored state: the new one, or the old one back.
      if (isCurrent(h)) setOptimistic((current) => {
        const next = { ...current };
        delete next[food.id];
        return next;
      });
    }
  }

  return { isStarred, toggle, error };
}

function foodRefs(rows: FavoriteRow[]): Set<string> {
  return new Set(rows.filter((row) => row.kind === "food").map((row) => row.id));
}

/** Whether `key` is starred in the device store now, or null when that cannot be read. */
async function storedState(key: string): Promise<boolean | null> {
  try { return foodRefs(await listFavorites()).has(key); } catch { return null; }
}
