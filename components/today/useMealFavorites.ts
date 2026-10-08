"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MealFavorite } from "@/components/MealFavoriteHeart";
import type { ActionFeedbackNotice } from "@/components/ui/ActionFeedback";
import { currentAccountOrNull } from "@/lib/device/account";
import {
  favoriteMealFor, removeFavoriteMeal, saveFavoriteMeal, undoSaveFavoriteMeal, type FavoriteMealSource,
} from "@/lib/favorite-meals-client";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { ResolvedSlot } from "@/lib/types";

type Feedback = { notify: (notice: ActionFeedbackNotice) => void };

const sourceOf = (date: string, slot: ResolvedSlot): FavoriteMealSource =>
  ({ date, slotId: slot.slot, mealId: slot.meal?.id ?? null });
/** One plate: its date, slot and the meal on it — a swapped meal is another plate. */
const keyOf = (source: FavoriteMealSource) => `${source.date}|${source.slotId}|${source.mealId ?? ""}`;

/**
 * The meal card heart on Today (meal cards v3; lib/favorite-meals-client.ts). Called above Today's
 * mount gate, so it takes no slots: `favoriteFor(slot)` asks for a plate as the card renders, and
 * an effect reads each asked-for plate's saved meal once, and again after every sync. Heart on saves
 * the plate (and Favors its foods, under the day's verified set); heart off removes that saved meal
 * by id, and its foods stay Favored. Each write confirms in the page's toast with an exact Undo, and
 * a write whose account has gone settles quietly.
 */
export function useMealFavorites({ eligible, feedback }: {
  eligible: ReadonlySet<string> | null; feedback: Feedback;
}) {
  const [saved, setSaved] = useState<Record<string, string | null>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(new Map<string, FavoriteMealSource>());
  const reading = useRef(new Set<string>());
  const epoch = useRef(0);

  useEffect(() => {
    const onSynced = () => { epoch.current += 1; reading.current.clear(); setSaved({}); };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, []);

  // After every render: read the plates the cards asked for that are neither known nor in flight.
  useEffect(() => {
    for (const [key, source] of asked.current) {
      if (key in saved || reading.current.has(key)) continue;
      reading.current.add(key);
      const at = epoch.current;
      void favoriteMealFor(source).catch(() => null).then((id) => {
        reading.current.delete(key);
        if (at === epoch.current) setSaved((value) => ({ ...value, [key]: id }));
      });
    }
    asked.current.clear();
  });

  const setOne = (key: string, id: string | null) => setSaved((value) => ({ ...value, [key]: id }));
  const busy = (key: string, on: boolean) => setPending((value) => {
    const next = new Set(value);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  const save = useCallback(async (slot: ResolvedSlot, source: FavoriteMealSource, withUndo: boolean) => {
    const key = keyOf(source);
    const name = slot.meal?.name ?? slot.label;
    const account = currentAccountOrNull();
    busy(key, true);
    try {
      const result = await saveFavoriteMeal({ name, components: slot.components, source },
        { eligible: eligible ?? undefined });
      if (currentAccountOrNull()?.userId !== account?.userId) return;
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      setOne(key, result.id);
      if (!withUndo) return;
      const skipped = result.skipped.length > 0
        ? ` Not favored under your food rules: ${result.skipped.join(", ")}.` : "";
      feedback.notify({ tone: "success", message: `${name} saved to favorite meals.${skipped}`,
        action: { label: "Undo", action: () => {
          void undoSaveFavoriteMeal(result.id, result.newlyFavored).then((undone) => {
            if (!undone.ok) { feedback.notify({ tone: "error", message: undone.message }); return; }
            setOne(key, null);
          });
        } } });
    } finally {
      busy(key, false);
    }
  }, [eligible, feedback]);

  const remove = useCallback(async (slot: ResolvedSlot, source: FavoriteMealSource, id: string) => {
    const key = keyOf(source);
    const name = slot.meal?.name ?? slot.label;
    const account = currentAccountOrNull();
    busy(key, true);
    try {
      const result = await removeFavoriteMeal(id);
      if (currentAccountOrNull()?.userId !== account?.userId) return;
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      setOne(key, null);
      feedback.notify({ tone: "success", message: `${name} removed from favorite meals. Its foods stay Favored.`,
        action: { label: "Undo", action: () => { void save(slot, source, false); } } });
    } finally {
      busy(key, false);
    }
  }, [feedback, save]);

  /** The heart for one planned card on `date`; undefined (no heart) until its saved meal is known. */
  const favoriteFor = (slot: ResolvedSlot, date: string): MealFavorite | undefined => {
    if (slot.meal === null) return undefined;
    const source = sourceOf(date, slot);
    const key = keyOf(source);
    if (!(key in saved)) { asked.current.set(key, source); return undefined; }
    const id = saved[key];
    return {
      on: id !== null, pending: pending.has(key),
      onToggle: () => { void (id ? remove(slot, source, id) : save(slot, source, true)); },
    };
  };

  return { favoriteFor };
}
