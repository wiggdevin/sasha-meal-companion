"use client";

import { useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import Tag from "@/components/ui/Tag";
import ReasonChips from "@/components/meals/ReasonChips";
import { CONFIRM_MS, useButtonStatus } from "@/components/ui/useButtonStatus";
import { portionLine, suggestionPhoto } from "@/components/recipes-hub/SuggestionCard";
import SuggestionCarousel from "@/components/recipes-hub/SuggestionCarousel";
import type { ButtonStatus } from "@/components/ui/Button";
import { AccountChanged, assertCurrent, currentAccountOrNull } from "@/lib/device/account";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { readPrefRefCache } from "@/lib/foods/prefs-client";
import { foodSignal, sendFoodSignals } from "@/lib/foods/signals-client";
import { favoriteMealSlots } from "@/lib/favorite-meals-client";
import { listRecipes } from "@/lib/recipes-client";
import { allRows } from "@/lib/sync/idb";
import { occasionAt } from "@/lib/meals/occasion";
import { recentSwapAlternatives, swapAlternatives, type SavedMealRow, type SwapAlternative }
  from "@/lib/today/swap-alternatives";
import { recentMeals } from "@/lib/log/recent-meals";
import { loadStore } from "@/lib/store";
import { swapSignalEvents } from "@/components/signals/swap-sheet-signals";
import type { Food } from "@/lib/foods";
import type { Macros, ResolvedSlot } from "@/lib/types";

/** Two arrows passing: the Swap flow's mark. */
function SwapGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4 3 8l4 4" /><path d="M3 8h13a4 4 0 0 1 4 4" /><path d="m17 20 4-4-4-4" /><path d="M21 16H8a4 4 0 0 1-4-4" />
  </svg>;
}

const FAILED = "Couldn’t change this meal. Try again.";

/** An open swap card: each of the meal's foods by its full name with its own calories (the card's
 *  line above already gives the amounts), then "Swap to this". */
function SwapDetail({ option, saving, status, onSwap }: {
  option: SwapAlternative; saving: boolean; status: ButtonStatus; onSwap: () => void;
}) {
  // While another action runs, or once a swap has saved, the button stays put but takes no tap; its
  // own pending and "Swapped" states still show.
  return <div className="flex min-w-0 flex-col gap-3 pb-1">
    <ul aria-label={`${option.name} foods`} className="m-0 flex list-none flex-col p-0">
      {option.components.map((item, index) => <li key={`${item.name}-${index}`}
        className="flex min-h-11 items-center gap-3 border-b border-hairline last:border-transparent">
        {/* The full name wraps: "drained" or "in oil" is the part that tells two foods apart. */}
        <span className="min-w-0 flex-1 break-words py-1 text-caption text-charcoal">{item.name}</span>
        <span className="shrink-0 text-tiny tabular-nums text-muted">{Math.round(item.macros.kcal)} kcal</span>
      </li>)}
    </ul>
    <Button variant="primary" size="lg" block disabled={saving && status === "idle"} status={status}
      aria-disabled={saving || undefined} confirmLabel="Swapped" errorLabel="Try again"
      onClick={() => { if (!saving) onSwap(); }}>Swap to this</Button>
  </div>;
}

/**
 * Other meals for this slot, sized like it (lib/today/swap-alternatives.ts), as a carousel of image
 * cards inside the meal card (2026-10-04, owner: "designed as the recipe card that's on the foods page
 * where we're able to horizontally scroll with images and descriptions of the recommended meals").
 * A tap grows a card in place to show the meal's foods; its "Swap to this" re-checks the account's
 * food rules at the write and confirms in the button ("Swapped") before the flow folds back into the
 * card, whose hero now shows the new meal. "Edit this meal" and "Back to the suggested meal" stay as quieter actions.
 * Every number on a card is that meal's own.
 */
export default function MealSwapSheet({ slot, date, target, foods, currentOverride,
  onSelect, onReset, onEdit, onClose }: {
  slot: ResolvedSlot;
  /** The viewed date: with the slot's time it sets the meal occasion the plates are ranked for. */
  date?: string;
  target: Macros | undefined; foods: Record<string, Food>;
  currentOverride: boolean;
  onSelect: (option: SwapAlternative) => Promise<void>;
  onReset: () => Promise<void>; onEdit: () => void; onClose: () => void;
}) {
  const [account] = useState(currentAccountOrNull);
  const [options, setOptions] = useState<SwapAlternative[]>([]);
  /** W123: meals logged before, sized to this slot (`logged:<entryId>`). */
  const [recent, setRecent] = useState<SwapAlternative[]>([]);
  const [loading, setLoading] = useState(!!account && !!target);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The opening load failed outright (not a swap's own error): its notice offers Try again. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryLoad = () => { setError(null); setLoadFailed(false); setLoading(true); setAttempt((n) => n + 1); };
  const swap = useButtonStatus();
  /** The user closed the flow while a save ran: the save still lands, the flow does not reclose. */
  const dismissed = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const dismiss = () => { dismissed.current = true; onClose(); };
  /** A swap has saved: from that moment until the flow closes every action is locked, so a second tap
   *  on the confirming button, or "Back to the suggested meal", cannot write again (Sol review S1). */
  const [swapped, setSwapped] = useState(false);
  const saving = swap.status === "pending" || resetting || swapped;
  /** One id per opening of this sheet: the swap sheet's `swapped_away` and `picked` signals
   *  (Phase 18 W6) share it. */
  const slateId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    let live = true;
    if (!account || !target) return;
    void loadEligibleLocalFoodIds(account, foods).then(async (allowed) => {
      assertCurrent(account);
      if (!live) return;
      const safeFoods = Object.fromEntries(Object.entries(foods)
        .filter(([id]) => allowed.has(id)));
      setOptions(swapAlternatives({ slot: slot.slot, target, foods: safeFoods,
        currentMealId: slot.meal?.id, currentComponents: slot.components,
        clock: slot.time, date, eligible: allowed }));
      let recipes: Awaited<ReturnType<typeof listRecipes>> = [];
      let rows: SavedMealRow[] = [];
      let savedSlots: Awaited<ReturnType<typeof favoriteMealSlots>> = {};
      try {
        [recipes, rows, savedSlots] = await Promise.all([listRecipes(), allRows(account, "favorites_meals"),
          favoriteMealSlots(account)]) as [typeof recipes, SavedMealRow[], typeof savedSlots];
      } catch (caught) {
        if (caught instanceof AccountChanged) throw caught;
        if (live) setError("Saved meals aren’t available right now. Your foods are still here.");
      }
      assertCurrent(account);
      if (!live) return;
      const refs = readPrefRefCache(account.userId);
      setRecent(recentSwapAlternatives({ target, foods: safeFoods, refs,
        recent: recentMeals(loadStore().days, { limit: 20 }).map(({ entry }) =>
          ({ id: entry.id, name: entry.name, items: entry.items ?? [] })),
        currentComponents: slot.components }));
      setOptions(swapAlternatives({ slot: slot.slot, target, foods: safeFoods,
        refs, recipes, savedSlots,
        savedMeals: rows, currentMealId: slot.meal?.id, currentComponents: slot.components,
        clock: slot.time, date, eligible: allowed }));
    }).catch((caught: unknown) => {
      if (!live) return;
      if (caught instanceof AccountChanged) { onClose(); return; }
      setOptions([]);
      setLoadFailed(true);
      setError(caught instanceof Error && caught.message ? caught.message : "Couldn’t check your food rules. Try again.");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // This flow is keyed by slot and date on Today; its opening snapshot is fixed, and only a retry
    // after a failed load reads it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** The write behind a choice, checked against the account and its current food rules first. */
  async function write(option: SwapAlternative) {
    if (!account) throw new AccountChanged();
    assertCurrent(account);
    const allowed = await loadEligibleLocalFoodIds(account, foods);
    if (!option.foodIds.every((id) => allowed.has(id))) {
      throw new Error("Your food rules changed. Reopen swaps to see safe choices.");
    }
    await onSelect(option);
    assertCurrent(account);
  }

  /** After a swap has already saved: never blocks, never surfaces an error, never retried.
   *  `foodSignal` stamps its own `localDate` from the phone's real clock (not the viewed plan
   *  date), so this no longer depends on `date` being set — but `tappedAt` must still be the
   *  moment of the tap, not whenever the save happens to finish, or a save that straddles
   *  midnight would misreport its own date (Sol review r3 WARN). */
  function sendSwapSignals(option: SwapAlternative, tappedAt: Date) {
    // A Recent meal row is not in the ranked slate the signal reports, so it reports nothing.
    if (option.id.startsWith("logged:")) return;
    const events = swapSignalEvents({ slateId: slateId.current, currentComponents: slot.components,
      shownOptions: options, chosenOption: option, foods,
      occasion: occasionAt(slot.time, { slot: slot.slot }) });
    // sendFoodSignals rethrows AccountChanged (lib/device/account.ts rethrowAccountChanged); this
    // tap already succeeded, so that must never become an unhandled rejection (Sol review r1).
    if (events.length) {
      void sendFoodSignals(events.map((event) => foodSignal(event, tappedAt))).catch(() => {});
    }
  }

  async function swapTo(option: SwapAlternative) {
    if (saving) return;
    const tappedAt = new Date();
    setError(null);
    const outcome = await swap.run(() => write(option));
    if (outcome.ok) {
      setSwapped(true);
      sendSwapSignals(option, tappedAt);
      // The button holds "Swapped" while the hero above shows the new meal, then the flow folds.
      closeTimer.current = setTimeout(() => { if (!dismissed.current) onClose(); }, CONFIRM_MS);
      return;
    }
    if (outcome.error instanceof AccountChanged) { onClose(); return; }
    setError(outcome.error instanceof Error && outcome.error.message ? outcome.error.message : FAILED);
  }

  async function backToSuggested() {
    if (saving) return;
    try {
      if (!account) throw new AccountChanged();
      assertCurrent(account);
      setResetting(true);
      setError(null);
      await onReset();
      assertCurrent(account);
      if (!dismissed.current) onClose();
    } catch (caught) {
      if (caught instanceof AccountChanged) { onClose(); return; }
      setError(caught instanceof Error && caught.message ? caught.message : FAILED);
    } finally { setResetting(false); }
  }

  return <Sheet title={`Swap ${slot.label}`} inset={{ label: "Swap", glyph: <SwapGlyph /> }}
    subtitle="Other meals sized to this slot’s plan, from your foods and saved meals." onClose={dismiss}>
    <div className="flex min-w-0 flex-col gap-3">
      {loading && <p role="status" className="m-0 text-caption text-graphite">Checking your food rules and saved meals…</p>}
      {error && <Notice tone="error" title={error}
        action={loadFailed ? { label: "Try again", onClick: retryLoad } : undefined} />}
      {target && options.length === 0 && recent.length === 0 && !loading && !error && <Notice tone="neutral"
        title="No close matches for this slot yet. Check your food rules, or edit this meal." />}
      {/* Swaps are sized to the slot's target: with none (no target revision in force, or a slot that
          carries no target) there is nothing to size them to, and the sheet says so rather than
          showing an empty body (UI audit 2026-10-07). */}
      {!target && <Notice tone="neutral"
        title="Meals to swap in are sized to this meal's target, and it has none right now. You can still edit this meal." />}
      {/* One card system with the Foods hub and a menu's picks: a tap grows the card in place to show
          the meal's foods and "Swap to this" (components/recipes-hub/SuggestionCarousel.tsx). */}
      {options.length > 0 && <SuggestionCarousel label="Meals to swap in" nested
        items={options.map((option) => ({ id: option.id, name: option.name,
          image: suggestionPhoto(option.name, option.components),
          description: portionLine(option.components), values: option.macros,
          tag: <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            <Tag size="md" tone={option.source === "Your foods" ? "neutral" : "olive"}>{option.source}</Tag>
            <ReasonChips reasons={option.reasons} size="md" />
          </span>,
          detail: <SwapDetail option={option} saving={saving} status={swap.status}
            onSwap={() => { void swapTo(option); }} /> }))} />}
      {recent.length > 0 && <p className="m-0 text-overline text-graphite">Recent meals</p>}
      {recent.length > 0 && <SuggestionCarousel label="Recent meals" nested
        items={recent.map((option) => ({ id: option.id, name: option.name,
          image: suggestionPhoto(option.name, option.components),
          description: portionLine(option.components), values: option.macros,
          tag: <Tag size="md" tone="olive">{option.source}</Tag>,
          detail: <SwapDetail option={option} saving={saving} status={swap.status}
            onSwap={() => { void swapTo(option); }} /> }))} />}
      <div className="flex min-w-0 flex-wrap justify-center gap-x-2">
        <Button variant="ghost" disabled={saving} onClick={onEdit}>Edit this meal</Button>
        {currentOverride && <Button variant="ghost" disabled={saving}
          status={resetting ? "pending" : undefined} onClick={() => { void backToSuggested(); }}>
          Back to the suggested meal
        </Button>}
      </div>
    </div>
  </Sheet>;
}
