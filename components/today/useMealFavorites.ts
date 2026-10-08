"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MealFavorite } from "@/components/MealFavoriteHeart";
import type { ActionFeedbackNotice } from "@/components/ui/ActionFeedback";
import { AccountChanged } from "@/lib/device/account";
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
  /** Plate → the token of its one read in flight; a finished read clears only its own token. */
  const reading = useRef(new Map<string, { token: symbol; at: number }>());
  /** Plates with a write or an Undo running: read synchronously, so a second tap never starts one. */
  const writing = useRef(new Set<string>());
  const epoch = useRef(0);
  /** The sync epoch each plate was last read in: an older one is read again, its heart kept meanwhile. */
  const readAt = useRef(new Map<string, number>());
  /** Failed reads per plate in this sync epoch: retried with a backoff, then left for the next sync. */
  const failures = useRef(new Map<string, number>());
  /** One backoff timer per plate, so one plate's failure never delays another's retry. */
  const retries = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  const [, setSyncs] = useState(0);

  useEffect(() => {
    // A sync re-reads every plate in place (never a blank cache, so no heart blinks off and on).
    const onSynced = () => { epoch.current += 1; failures.current.clear(); setSyncs((value) => value + 1); };
    window.addEventListener(SYNCED_EVENT, onSynced);
    mounted.current = true;
    const timers = retries.current;
    return () => {
      mounted.current = false;
      window.removeEventListener(SYNCED_EVENT, onSynced);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // After every render: read the plates the cards asked for that are not current nor in flight.
  useEffect(() => {
    for (const [key, source] of asked.current) {
      // A read from an older sync does not count: a newer one starts, and the older one's answer is dropped.
      if (readAt.current.get(key) === epoch.current || reading.current.get(key)?.at === epoch.current) continue;
      const token = Symbol(key);
      const at = epoch.current;
      reading.current.set(key, { token, at });
      void favoriteMealFor(source).then((id) => ({ ok: true as const, id }), () => ({ ok: false as const }))
        .then((read) => {
          if (reading.current.get(key)?.token === token) reading.current.delete(key);
          if (!mounted.current || at !== epoch.current) return;
          if (read.ok) {
            readAt.current.set(key, at);
            failures.current.delete(key);
            setSaved((value) => ({ ...value, [key]: read.id }));
            return;
          }
          // A failed read is not "not saved": the plate keeps what it last knew, or shows no heart (so a
          // tap can never offer an Undo that removes a meal saved before). It is retried after 1, 2 and
          // 4 s; after a fourth failure it waits for the next sync.
          const tries = (failures.current.get(key) ?? 0) + 1;
          failures.current.set(key, tries);
          if (tries > 3) { readAt.current.set(key, at); return; }
          clearTimeout(retries.current.get(key));
          retries.current.set(key, setTimeout(() => {
            retries.current.delete(key);
            if (mounted.current) setSyncs((value) => value + 1);
          }, 1000 * 2 ** (tries - 1)));
        });
    }
    asked.current.clear();
  });

  const setOne = (key: string, id: string | null) => {
    readAt.current.set(key, epoch.current);
    setSaved((value) => ({ ...value, [key]: id }));
  };
  const busy = (key: string, on: boolean) => {
    if (on) writing.current.add(key); else writing.current.delete(key);
    setPending((value) => {
      const next = new Set(value);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  };
  /** Clears a plate only while it still holds this saved meal: a newer save is never undone by a late answer. */
  const clearIf = (key: string, id: string) => {
    // No read mark here: a sync that landed meanwhile still re-reads the plate's newer state.
    setSaved((value) => (value[key] === id ? { ...value, [key]: null } : value));
  };

  const save = useCallback(async (slot: ResolvedSlot, source: FavoriteMealSource, withUndo: boolean) => {
    const key = keyOf(source);
    const name = slot.meal?.name ?? slot.label;
    busy(key, true);
    try {
      const result = await saveFavoriteMeal({ name, components: slot.components, source },
        { eligible: eligible ?? undefined });
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      setOne(key, result.id);
      if (!withUndo) return;
      // `skipped` holds foods a rule kept out and foods still waiting on a rules check.
      const skipped = result.skipped.length > 0 ? ` Not favored yet: ${result.skipped.join(", ")}.` : "";
      feedback.notify({ tone: "success", message: `${name} saved to favorite meals.${skipped}`,
        action: { label: "Undo", action: () => {
          if (writing.current.has(key)) return;
          busy(key, true);
          void undoSaveFavoriteMeal(result.id, result.newlyFavored).then((undone) => {
            if (!undone.ok) { feedback.notify({ tone: "error", message: undone.message }); return; }
            clearIf(key, result.id);
          }).catch((error: unknown) => { if (!(error instanceof AccountChanged)) throw error; })
            .finally(() => busy(key, false));
        } } });
    } catch (error) {
      // The write belongs to nobody now (account changed mid-write): settle quietly, as every
      // other caller of this client does, rather than an unhandled rejection from `void save(...)`.
      if (!(error instanceof AccountChanged)) throw error;
    } finally {
      busy(key, false);
    }
  }, [eligible, feedback]);

  const remove = useCallback(async (slot: ResolvedSlot, source: FavoriteMealSource, id: string) => {
    const key = keyOf(source);
    const name = slot.meal?.name ?? slot.label;
    busy(key, true);
    try {
      const result = await removeFavoriteMeal(id);
      if (!result.ok) { feedback.notify({ tone: "error", message: result.message }); return; }
      clearIf(key, id);
      feedback.notify({ tone: "success", message: `${name} removed from favorite meals. Your Favored foods are unchanged.`,
        action: { label: "Undo", action: () => { if (!writing.current.has(key)) void save(slot, source, false); } } });
    } catch (error) {
      if (!(error instanceof AccountChanged)) throw error;
    } finally {
      busy(key, false);
    }
  }, [feedback, save]);

  /** The heart for one planned card on `date`; undefined (no heart) until its saved meal is known. */
  const favoriteFor = (slot: ResolvedSlot, date: string): MealFavorite | undefined => {
    if (slot.meal === null) return undefined;
    const source = sourceOf(date, slot);
    const key = keyOf(source);
    if (readAt.current.get(key) !== epoch.current) asked.current.set(key, source);
    if (!(key in saved)) return undefined;
    const id = saved[key];
    return {
      on: id !== null, pending: pending.has(key),
      onToggle: () => {
        if (writing.current.has(key)) return;
        void (id ? remove(slot, source, id) : save(slot, source, true));
      },
    };
  };

  return { favoriteFor };
}
