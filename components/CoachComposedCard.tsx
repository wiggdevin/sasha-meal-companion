"use client";

/**
 * The card `compose_meal` produces — T6 §4. Three buttons, and each one is an ordinary coach
 * action: Log it, Put it in <slot>, Save as recipe. Every item on it was grounded and
 * policy-checked on the SERVER; this component builds the action from that grounding and never
 * invents a food.
 *
 * Amber for a flagged item is F-078's colour, the one warning colour in DESIGN.md. No new colours.
 */

import Button from "@/components/ui/Button";
import ReasonChips from "@/components/meals/ReasonChips";
import { useState } from "react";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import { clockNow, localDate } from "@/lib/coach/chat-state";
import type { ComposedMeal } from "@/lib/coach/compose";
import { MAX_TERMS } from "@/lib/coach/compose-terms";
import { mealProvenance } from "@/lib/coach/message-view";
import type { SlotId } from "@/lib/types";
import { MacroLine } from "@/components/nutrition/MacroText";
import KcalText from "@/components/ui/KcalText";
import AiLabel from "@/components/ui/AiLabel";
import type { Provenance } from "@/lib/types";
import { MEAL_TITLE } from "@/lib/design/meal-type";
import { occasionAt } from "@/lib/meals/occasion";
import { composedMealSignalEvents, SUGGESTION_CARD_RANKING_VERSION }
  from "@/components/signals/composed-meal-signals";
import { foodSignal, sendFoodSignals } from "@/lib/foods/signals-client";

export function slotLabel(slot: string): string {
  return /^meal-[1-6]$/.test(slot) ? slot.replace("meal-", "Meal ") : slot;
}

function groundedItems(meal: ComposedMeal): GroundedActionItem[] {
  return meal.items.map((item) => ({
    name: item.name, grams: item.grams, foodRefId: item.foodRefId,
    catalogFoodRevisionId: item.catalogFoodRevisionId,
    kcalPer100g: item.kcalPer100g, proteinPer100g: item.proteinPer100g,
    carbsPer100g: item.carbsPer100g, fatPer100g: item.fatPer100g,
    verdict: item.verdict,
  }));
}

/**
 * The three actions the buttons emit, MINTED AT TAP.
 *
 * The date, the clock time and the actionId used to be computed when the card rendered, so a card
 * left open across midnight logged at yesterday's date under an id that had already been recalled
 * as applied (Grok pass 1, MEDIUM 21). `now` is read when the button is tapped.
 */
export function composedActions(
  meal: ComposedMeal, slot: string | null,
  clock: { date: string; at: string }, newId: () => string,
): { log: CoachAction; slot: CoachAction | null; recipe: CoachAction } {
  const items = groundedItems(meal);
  const flagged = meal.flagged;
  return {
    // "Log it" is ALWAYS a snack at the time of the tap (spec §4): the user is telling the app they are
    // eating this NOW, which is an extra, not a plan slot. Putting the card's slot on it instead
    // logged a meal against a slot they had not eaten (Grok pass 2, HIGH 1). Only "Put it in
    // <slot>" below is about the plan.
    log: { kind: "log_meal", actionId: newId(), flagged, date: clock.date,
      slot: "snack", at: clock.at, items },
    slot: slot
      ? { kind: "set_slot_meal", actionId: newId(), flagged, date: clock.date,
          slot: slot as SlotId, items }
      : null,
    recipe: { kind: "save_recipe", actionId: newId(), flagged,
      name: meal.wish.slice(0, 80), items },
  };
}

/** Where "Put it in …" points: the slot the wish named, else the next meal still pending. */
export function defaultSlot(meal: ComposedMeal): string | null {
  return meal.slot ?? meal.pendingSlots?.[0]?.slot ?? null;
}

/** What a meal that misses the slot says. Older stored turns carry no note; they still say it. */
export const FIT_FALLBACK = "This does not quite fit the slot";

/**
 * Phase 18 W9: a direct wish that named foods with no coherent plate (`meal.incomplete`) always
 * has `fitsTarget: false` and `fitNote: null` — exactly the shape `fitLine` otherwise falls back
 * to `FIT_FALLBACK` for, which would say the meal "does not quite fit" when really nothing was
 * ever built. Checked first, so an incomplete draft always says WHY in its own words rather than
 * the generic miss-the-slot line (UI-NEEDS W9, Sol r1 BLOCK, verified).
 */
export function fitLine(
  meal: Pick<ComposedMeal, "fitsTarget" | "fitNote" | "incomplete">,
): string | null {
  if (meal.incomplete) return `Couldn't make a full meal from those: ${meal.incomplete.reason}`;
  if (meal.fitsTarget) return null;
  return meal.fitNote ?? FIT_FALLBACK;
}

/** OD26: names the foods the user asked for that this meal does not hold; null when none. */
export function leftOutLine(meal: Pick<ComposedMeal, "leftOut">): string | null {
  const out = meal.leftOut ?? [];
  const named = (why: "over_limit" | "not_found") =>
    out.filter((entry) => entry.why === why).map((entry) => entry.term).join(", ");
  const over = named("over_limit");
  const missing = named("not_found");
  const parts = [
    over && `Left out ${over}: I use up to ${MAX_TERMS} foods per meal.`,
    missing && `Left out ${missing}: no match you can eat.`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * True for `meal.incomplete` (D12: every named food kept with grams/macros at 0, nothing added)
 * or any other all-zero-gram draft — nothing here was ever sized, so none of the three actions
 * may build a loggable action from it (UI-NEEDS W9, verified).
 */
export function isIncompleteDraft(meal: Pick<ComposedMeal, "incomplete" | "items">): boolean {
  return !!meal.incomplete || meal.items.every((item) => item.grams === 0);
}

export default function CoachComposedCard({
  meal, onAction, tz, newId = () => crypto.randomUUID(), now = () => new Date(), provenance,
  slate, slateId, rankingVersion = SUGGESTION_CARD_RANKING_VERSION,
}: {
  meal: ComposedMeal; tz: string;
  /** The turn's provenance, for a compose_meal card that carries none of its own (PR #373). */
  provenance?: Provenance;
  onAction: (action: CoachAction) => void;
  newId?: () => string;
  now?: () => Date;
  /**
   * Every meal shown alongside this one in the same reply (Phase 18 W6), and one id shared by
   * them for the life of that showing. Omitted (older callers): no signal is sent, so a caller
   * that does not yet track its own slate sees no behaviour change.
   */
  slate?: readonly ComposedMeal[];
  slateId?: string;
  rankingVersion?: string;
}) {
  const offered = meal.pendingSlots ?? [];
  const leftOut = leftOutLine(meal);
  const [slot, setSlot] = useState<string | null>(defaultSlot(meal));
  if (meal.items.length === 0) return null;
  const incomplete = isIncompleteDraft(meal);
  const swapped = meal.items.filter((item) => item.insteadOf);
  const madeBy = mealProvenance(meal, provenance);
  const emit = (pick: (a: ReturnType<typeof composedActions>) => CoachAction | null) => {
    const at = now();
    const date = localDate(tz, at);
    const action = pick(composedActions(meal, slot, { date, at: clockNow(tz, at) }, newId));
    if (!action) return;
    onAction(action);
    // "Picked": the tap committed this meal (logged it, or put it in a slot) rather than merely
    // bookmarking it ("Save as recipe" is not a pick). Fire-and-forget, after the action is already
    // dispatched; never blocks, never surfaces an error (Phase 18 W6).
    if (slate && slateId && (action.kind === "log_meal" || action.kind === "set_slot_meal")) {
      // The suggestion's own occasion, not the tap's: `meal.mealType` is the occasion the slot
      // clock named when the card was built (lib/coach/meal-type.ts: `MealType = Occasion`), so a
      // breakfast suggestion put into its slot after dinner still reports "breakfast" (Sol review
      // r3 WARN) — true for this component wherever it's rendered directly from the API's own
      // `ComposedMeal[]` (e.g. `ShellComposedCards`). It is NOT true for an idea that passed
      // through `composedMealSchema` first (the `food_ideas` block): that schema carries neither
      // `mealType` nor `mealClock` (lib/coach/ui-blocks.ts), so such a card falls through to
      // `occasionAt(undefined, { slot })`, which honestly answers "other" rather than guessing —
      // never the tap's own clock. Closing that gap needs a schema change (UI-NEEDS, out of scope
      // for this diff). A `compose_meal` card may also carry neither field; same fallback.
      const occasion = meal.mealType ?? occasionAt(meal.mealClock, { slot });
      const events = composedMealSignalEvents({ slateId, surface: "suggestion_card", kind: "picked",
        slate, chosen: meal, occasion, rankingVersion });
      // sendFoodSignals rethrows AccountChanged (lib/device/account.ts rethrowAccountChanged);
      // the action is already dispatched, so this must never become an unhandled rejection.
      if (events.length) void sendFoodSignals(events.map((event) => foodSignal(event))).catch(() => {});
    }
  };
  return (
    // The small card frame (UI makeover §3.3: card-sm, 12 px padding, 16 px corners).
    <div className="shell">
      <div className="surface card-sm card-ivory flex flex-col">
        {/* Every meal card names its meal (KIT §14); a composed plate has no name of its own. */}
        <h3 className={`m-0 ${MEAL_TITLE.compact}`}>Your meal</h3>
        {/* W099: why these foods (open food world only), shown on a complete and an incomplete card alike. */}
        <ReasonChips reasons={meal.reasons} className="self-start" />
        <ul className="m-0 list-none p-0">
          {meal.items.map((item) => (
            <li key={item.foodRefId} className="flex items-baseline justify-between gap-3 text-caption font-normal text-charcoal">
              <span className="min-w-0 truncate">
                {item.addedFor ? "+ " : ""}{item.name}
                {item.addedFor && (
                  <span className="font-normal text-muted"> for {item.addedFor}</span>
                )}
              </span>
              <span className="font-normal text-muted">{item.grams} g</span>
            </li>
          ))}
        </ul>

        {/* Nothing here was ever sized (incomplete, or every item at 0 g): a 0/0/0/0 line would
            read as measured nutrition rather than what it is -- nothing built (Sol r1 WARN). */}
        {!incomplete && (
          <div className="olive-panel px-3 py-2 tabular-nums text-tiny font-normal">
            <MacroLine values={meal.totals} /> · <KcalText text={
              meal.fitsTarget ? "fits what is left" : `target ${Math.round(meal.target.kcal)} kcal`} />
          </div>
        )}

        {/*
          * A meal that misses the slot used to render exactly like one that hits it, so a wrap
          * 22 g over on protein looked like an answer (ruling 2026-09-18). The composer's own fit
          * verdict is SAID, in one line, in the one warning colour.
          */}
        {fitLine(meal) && (
          <p className="m-0 text-tiny font-normal text-warning">
            {fitLine(meal)}
          </p>
        )}

        {leftOut && <p className="m-0 text-tiny font-normal text-warning">{leftOut}</p>}

        {/* The card's one AI label sits in its tag slot, beside the rank note it explains. */}
        {(meal.rankNote || madeBy?.ai) && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            {meal.rankNote ? <p className="m-0 min-w-0 text-tiny font-normal text-primary">
              {meal.rankNote}
            </p> : <span />}
            <AiLabel provenance={madeBy} />
          </div>
        )}

        {swapped.map((item) => (
          <p key={`${item.foodRefId}-swap`} className="m-0 text-tiny font-normal text-muted">
            {item.name} instead of {item.insteadOf}
          </p>
        ))}
        {meal.flagged.length > 0 && (
          <p className="m-0 text-tiny font-normal text-warning">
            Off-plan: {meal.flagged.join(", ")}
          </p>
        )}

        {/* More than one meal still to come: the user picks which one before putting it there. */}
        {!incomplete && slot && offered.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {offered.map((row: { slot: string; label: string }) => (
              <Button key={row.slot} size="sm" variant={slot === row.slot ? "primary" : "tertiary"}
                onClick={() => setSlot(row.slot)} aria-pressed={slot === row.slot}>
                {row.label}
              </Button>
            ))}
          </div>
        )}

        {/* Nothing here was ever sized (incomplete, or every item at 0 g): none of Log, Put in
            <slot> or Save as recipe may build a loggable action from it (UI-NEEDS W9, verified). */}
        {!incomplete && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => emit((a) => a.log)}>Log it</Button>
            {slot && (
              <Button variant="secondary" onClick={() => emit((a) => a.slot)}>Put it in {slotLabel(slot)}</Button>
            )}
            {/* Two actions lead (UI makeover: at most two per card); saving it stays a quiet third. */}
            <Button variant="ghost" onClick={() => emit((a) => a.recipe)}>Save as recipe</Button>
          </div>
        )}
      </div>
    </div>
  );
}
