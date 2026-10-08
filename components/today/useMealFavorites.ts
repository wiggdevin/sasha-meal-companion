"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * The meal card heart on Today (meal cards v3; lib/favorite-meals-client.ts). Each planned plate's
 * saved meal is read when the day's plates change and again after every sync. Heart on saves the
 * plate (and Favors its foods, under the day's verified set); heart off removes that saved meal by
 * id, and its foods stay Favored. Each write confirms in the page's toast with an exact Undo, and a
 * write whose account has gone settles quietly.
 */
export function useMealFavorites({ date, slots, eligible, feedback }: {
  date: string; slots: readonly ResolvedSlot[]; eligible: ReadonlySet<string> | null; feedback: Feedback;
}) {
  const [saved, setSaved] = useState<Record<string, string | null>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [syncs, setSyncs] = useState(0);
  const planned = slots.filter((slot) => slot.meal !== null);
  const plates = planned.map((slot) => `${slot.slot}:${slot.meal?.id ?? ""}`).join("|");
  const slotsRef = useRef(planned);
  // Kept current before the read effect below runs (effects run in order), never during render.
  useLayoutEffect(() => { slotsRef.current = planned; });

  useEffect(() => {
    const onSynced = () => setSyncs((value) => value + 1);
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all(slotsRef.current.map(async (slot) =>
      [slot.slot, await favoriteMealFor(sourceOf(date, slot)).catch(() => null)] as const))
      .then((rows) => { if (live) setSaved(Object.fromEntries(rows)); });
    return () => { live = false; };
  }, [date, plates, syncs]);

  const setOne = (slotId: string, id: string | null) => setSaved((value) => ({ ...value, [slotId]: id }));
  const busy = (slotId: string, on: boolean) => setPending((value) => {
    const next = new Set(value);
    if (on) next.add(slotId); else next.delete(slotId);
    return next;
  });

  const save = useCallback(async (slot: ResolvedSlot, withUndo: boolean) => {
    const name = slot.meal?.name ?? slot.label;
    const account = currentAccountOrNull();
    busy(slot.slot, true);
    try {
      const result = await saveFavoriteMeal({ name, components: slot.components, source: sourceOf(date, slot) },
        { eligible: eligible ?? undefined });
      if (currentAccountOrNull()?.userId !== account?.userId) return;
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      setOne(slot.slot, result.id);
      if (!withUndo) return;
      const skipped = result.skipped.length > 0
        ? ` Not favored under your food rules: ${result.skipped.join(", ")}.` : "";
      feedback.notify({ tone: "success", message: `${name} saved to favorite meals.${skipped}`,
        action: { label: "Undo", action: () => {
          void undoSaveFavoriteMeal(result.id, result.newlyFavored).then((undone) => {
            if (!undone.ok) { feedback.notify({ tone: "error", message: undone.message }); return; }
            setOne(slot.slot, null);
          });
        } } });
    } finally {
      busy(slot.slot, false);
    }
  }, [date, eligible, feedback]);

  const remove = useCallback(async (slot: ResolvedSlot, id: string) => {
    const name = slot.meal?.name ?? slot.label;
    const account = currentAccountOrNull();
    busy(slot.slot, true);
    try {
      const result = await removeFavoriteMeal(id);
      if (currentAccountOrNull()?.userId !== account?.userId) return;
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      setOne(slot.slot, null);
      feedback.notify({ tone: "success", message: `${name} removed from favorite meals. Its foods stay Favored.`,
        action: { label: "Undo", action: () => { void save(slot, false); } } });
    } finally {
      busy(slot.slot, false);
    }
  }, [feedback, save]);

  const favoriteFor = (slot: ResolvedSlot): MealFavorite | undefined => {
    if (slot.meal === null || !(slot.slot in saved)) return undefined;
    const id = saved[slot.slot];
    return {
      on: id !== null, pending: pending.has(slot.slot),
      onToggle: () => { void (id ? remove(slot, id) : save(slot, true)); },
    };
  };

  return { favoriteFor };
}
