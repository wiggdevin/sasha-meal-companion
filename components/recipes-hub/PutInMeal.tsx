"use client";
/**
 * "Put it in a meal" (owner ask 2026-10-03): a recipe card or detail grows, in place, into a day row
 * (today and the next six) and that day's meal slots, each with its time and whether it is empty or
 * planned ("Replaces Chicken & rice"). Nothing is written until Put in … is tapped; then the catalog's
 * own recipe plan path runs (lib/recipe-plan-client.ts: preview, then accept), sized to the slot's
 * target, and the result is said inline. No sheet, no pop-up.
 *
 * One placement at a time, for the account that opened the picker (audit 2026-10-04): the account
 * is checked before the preview and again before the accept, and a result that arrives after an
 * account change or after the picker closed is dropped. An ingredient added to Avoid while the
 * picker is open stops the confirm.
 *
 * The lock outlives the picker (audit r4): it is a module-level flight keyed by account, recipe,
 * day and slot (components/single-flight.ts), not a ref the picker drops when it unmounts. Close
 * is disabled while a placement is on the wire, and a picker opened again for the same recipe
 * stays on "Placing…" until it lands, so a second accept with a fresh request id cannot go out.
 *
 * The outcome outlives the picker too (audit f2 MAJOR): success or error is recorded on the same
 * key the flight held, not only in this component's own `done`/`error` state. Collapsing the card
 * mid-accept and reopening it hydrates that outcome instead of showing a freshly enabled confirm
 * button over a placement that already went out — a second confirm cannot re-fire the accept with
 * a new request id for a slot this already filled. Acknowledging "Done" forgets it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CloseIcon } from "@/components/ui/CloseButton";
import Button from "@/components/ui/Button";
import { spring } from "@/lib/design/motion";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { useAvoidChanged } from "@/components/recipes-hub/useAvoidChanged";
import { clearFlightOutcome, flightOutcome, fly, flyingUnder, setFlightOutcome,
  useFlying } from "@/components/single-flight";
import { AccountChanged, assertCurrent, currentAccountOrNull, isCurrent } from "@/lib/device/account";
import { acceptRecipePlan, previewRecipePlan } from "@/lib/recipe-plan-client";
import { rulesUncheckedMark } from "@/lib/recipes/rule-mark-wire";
import { recipeRuleInputs, useRecipeRuleInputs, verdictNow } from "@/lib/recipes/recipe-freshness";
import { clock12, dayChoices, dayName, defaultSlot, localDate, slotChoices, slotState,
  type SlotChoice } from "@/lib/recipes-hub/put-in-meal";
import { displayAmount } from "@/lib/recipes/preview-display";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import Notice from "@/components/ui/Notice";
import RuleMark from "@/components/ui/RuleMark";
import type { RuleMark as RuleMarkValue } from "@/lib/types";

export type Placement = { initialDate?: string; initialSlotId?: string; onPlanned?: () => void };

/** A day's meal slots from the local plan, as the Today screen resolves them. */
export function readMealSlots(date: string): SlotChoice[] {
  try { return slotChoices(resolveDay(loadStore(), date).slots); } catch { return []; }
}

/** `ruleMark`: the placed plan under the current rules, as the accept answered it; never blocks. */
type Done = { slot: string; day: string; servings: number; approximate: boolean; ruleMark?: RuleMarkValue | null;
  /** The rule inputs the placement was read under: a later rule change shows it Checking (never redone). */
  inputs?: string };
/** `unchecked`: the preview's 422 (rules unread, nothing stored): a check to make, not a failure. */
type Outcome = { kind: "done"; done: Done } | { kind: "error"; error: string; unchecked?: boolean };

function estimatedNutrition(recipe: RecipeCandidate): boolean {
  return Object.values(recipe.nutritionPerServing).some((value) => value.status === "estimated")
    || recipe.ingredients.some((item) => Object.values(item.nutrition).some((value) => value.status === "estimated"));
}

const ACCOUNT_CHANGED = "Account changed. Close and reopen.";
const AVOIDED = "Your Avoid list changed. Search again before planning this recipe.";

/** The prefix every placement of `recipeId` for this account holds while it is in flight. */
export function placementPrefix(userId: string | undefined, recipeId: string): string {
  return `put-in-meal:${userId ?? "-"}:${recipeId}:`;
}

export function PutInMealPicker({ recipe, initialDate, initialSlotId, onPlanned, onClose, readSlots = readMealSlots }:
  Placement & { recipe: RecipeCandidate; onClose?: () => void; readSlots?: (date: string) => SlotChoice[] }) {
  const [today] = useState(() => localDate());
  const [opening] = useState(currentAccountOrNull);
  const flights = placementPrefix(opening?.userId, recipe.recipeId);
  const busy = useFlying(flights);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const avoided = useAvoidChanged(recipe);
  const avoidedNow = useRef(avoided);
  useEffect(() => { avoidedNow.current = avoided; }, [avoided]);
  const days = useMemo(() => dayChoices(today, 7, initialDate), [today, initialDate]);
  const [date, setDate] = useState(initialDate ?? today);
  const slots = useMemo(() => readSlots(date), [readSlots, date]);
  const [slotId, setSlotId] = useState<string | null>(() => defaultSlot(readSlots(initialDate ?? today), initialSlotId));
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState(false);
  const inputsNow = useRecipeRuleInputs();
  const [done, setDone] = useState<Done | null>(null);
  // A picker that mounts while a placement for the selected day/slot is already settled (closed
  // mid-accept, reopened on the same card) hydrates that outcome instead of a blank confirm
  // button — and so does one that mounted WHILE it was still in flight: `busy` (this same
  // `flights` prefix) going back to false is exactly the signal that an outcome may now exist,
  // since `setFlightOutcome` is written before the flight's own lock clears (audit g1 MAJOR).
  useEffect(() => {
    if (busy || !slotId) return;
    const outcome = flightOutcome<Outcome>(`${flights}${date}:${slotId}`);
    if (!outcome) return;
    // Hydrating from what a flight (this picker's own, or a prior one's) already left.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (outcome.kind === "done") setDone(outcome.done);
    else { setError(outcome.error); setUnchecked(outcome.unchecked === true); }
  }, [busy, flights, date, slotId]);
  const chosen = slots.find((slot) => slot.slotId === slotId && !slot.eaten) ?? null;
  const estimated = estimatedNutrition(recipe);
  const when = dayName(date, today);

  function pickDay(next: string) {
    if (next === date) return;
    setDate(next); setError(null);
    const nextSlots = readSlots(next);
    setSlotId((current) => nextSlots.some((slot) => slot.slotId === current && !slot.eaten) ? current
      : defaultSlot(nextSlots, next === initialDate ? initialSlotId : null));
  }

  function confirm() {
    if (!chosen || avoided || flyingUnder(flights)) return;
    const placing = { slot: chosen.label, slotId: chosen.slotId, day: when, date };
    setError(null);
    void fly(`${flights}${placing.date}:${placing.slotId}`, () => place(placing));
  }

  async function place(placing: { slot: string; slotId: string; day: string; date: string }) {
    const h = opening;
    const key = `${flights}${placing.date}:${placing.slotId}`;
    const inputs = recipeRuleInputs();
    try {
      if (!h) throw new AccountChanged();
      assertCurrent(h);
      const preview = await previewRecipePlan(recipe.recipeId, placing.date, placing.slotId);
      if (!mounted.current) return;
      assertCurrent(h);
      if (preview.recipe.revisionId !== recipe.revisionId)
        throw new Error("This recipe changed. Refresh the results before planning it.");
      if (!preview.approximateFitAvailable)
        throw new Error("Some nutrition is missing, so a portion can’t be sized here. Try Adjust portion.");
      if (avoidedNow.current) throw new Error(AVOIDED);
      // One request id for this attempt; the flight keeps a second attempt off the wire until it lands.
      const selection = await acceptRecipePlan(recipe.recipeId, preview.previewId, crypto.randomUUID(),
        !preview.exactFitAvailable);
      if (!isCurrent(h)) throw new AccountChanged();
      // The plan changed for this account: Today re-reads it even when the picker has closed.
      window.dispatchEvent(new Event("recipe-plan-accepted"));
      const result: Done = { slot: placing.slot, day: placing.day, servings: preview.servingFraction,
        approximate: !preview.exactFitAvailable, ruleMark: selection?.ruleMark ?? null, inputs };
      // Recorded regardless of mount, so a picker that remounts on this exact day/slot later
      // shows the placement already happened instead of an unclicked confirm (audit f2 MAJOR).
      setFlightOutcome(key, { kind: "done", done: result } satisfies Outcome);
      if (!mounted.current) return;
      setDone(result);
      onPlanned?.();
    } catch (cause) {
      const message = cause instanceof AccountChanged ? ACCOUNT_CHANGED
        : cause instanceof Error ? cause.message : "That didn’t save. Try again.";
      const rulesUnread = rulesUncheckedMark(cause) !== null;
      setFlightOutcome(key, { kind: "error", error: message, unchecked: rulesUnread } satisfies Outcome);
      if (!mounted.current) return;
      setError(message);
      setUnchecked(rulesUnread);
    }
  }

  const chip = (on: boolean) => on ? "btn-primary" : "border border-hairline bg-surface text-charcoal";
  return <section aria-label={`Put ${recipe.name} in a meal`} tabIndex={-1}
    onKeyDown={(event) => { if (event.key === "Escape" && onClose) { event.stopPropagation(); if (!busy) onClose(); } }}
    className="meal-detail-tray flex min-w-0 flex-col gap-3 rounded-3xl p-3">
    <div className="flex items-center justify-between gap-2">
      <p className="eyebrow m-0 text-muted">Put it in a meal</p>
      {onClose && <button type="button" onClick={onClose} aria-label="Close meal picker" disabled={busy}
        className="tap -my-2 -mr-1 flex size-11 items-center justify-center rounded-full text-muted disabled:opacity-40"><CloseIcon /></button>}
    </div>
    {done ? <div className="flex flex-col gap-2"><Notice tone="success" title={<>
        In {done.slot}, {done.day} · {displayAmount(done.servings, 2)} serving{done.servings === 1 ? "" : "s"}
        {done.approximate ? ", approximate" : ""}.</>}
      action={onClose ? { label: "Done", onClick: () => {
        if (slotId) clearFlightOutcome(`${flights}${date}:${slotId}`);
        onClose();
      } } : undefined} /><RuleMark mark={verdictNow(done.ruleMark, done.inputs, inputsNow)} /></div> : <>
      <div role="group" aria-label="Day" className="-mx-3 flex min-w-0 gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none]">
        {days.map((day) => { const on = day.date === date;
          return <button key={day.date} type="button" aria-pressed={on} aria-label={day.name} disabled={busy}
            onClick={() => pickDay(day.date)}
            className={`tap flex min-h-14 min-w-13 shrink-0 flex-col items-center justify-center rounded-full px-3 ${chip(on)}`}>
            <span className="text-tiny leading-tight">{day.label}</span>
            <span className="text-caption font-semibold leading-tight tabular-nums">{day.day}</span>
          </button>; })}
      </div>
      {slots.length === 0 ? <Notice tone="neutral" title={<>No meals are laid out for {when} yet.</>} />
        : <div role="group" aria-label="Meal" className="grid grid-cols-2 gap-2">
          {slots.map((slot) => { const on = slot.slotId === chosen?.slotId;
            const state = slotState(slot);
            const tone = on ? "text-on-primary" : slot.eaten ? "text-muted" : slot.planned ? "text-graphite" : "text-sage-ink";
            return <button key={slot.slotId} type="button" aria-pressed={on} disabled={slot.eaten || busy}
              onClick={() => { setSlotId(slot.slotId); setError(null); }}
              className={`tap flex min-h-14 min-w-0 flex-col items-start justify-center gap-0.5 rounded-2xl px-3 py-2 text-left
                disabled:opacity-40 ${chip(on)}`}>
              <span className="flex w-full items-baseline justify-between gap-2 text-caption font-semibold">
                <span>{slot.label}</span><span className="text-tiny font-medium tabular-nums">{clock12(slot.time)}</span></span>
              <span className={`w-full truncate text-tiny ${tone}`}>
                {slot.planned && !slot.eaten ? `Replaces ${state}` : state}</span>
            </button>; })}
        </div>}
      {chosen?.planned && <Notice tone="attention"
        title={<>This replaces {chosen.planned} in {chosen.label}.</>} />}
      <p className="m-0 text-tiny text-muted">
        The portion is sized to that meal’s target{estimated ? " from estimated nutrition" : ""}.</p>
      <Button variant="primary" block disabled={!chosen || busy || avoided} onClick={confirm}>
        {busy ? "Placing…" : chosen ? `Put in ${chosen.label}, ${when}` : "Choose a meal"}</Button>
      {avoided && <Notice tone="attention" title={AVOIDED} />}
      {error && <Notice tone={unchecked ? "attention" : "error"} title={error} />}
    </>}
  </section>;
}

/**
 * The trigger and the picker it grows into. Focus moves into the picker when it opens and back to
 * the trigger when it closes.
 */
export default function PutInMeal({ recipe, disabled = false, ...placement }:
  Placement & { recipe: RecipeCandidate; disabled?: boolean }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (open) { opened.current = true; panel.current?.querySelector<HTMLElement>("section")?.focus({ preventScroll: true }); }
    else if (opened.current) trigger.current?.focus({ preventScroll: true });
  }, [open]);
  return <div className="flex min-w-0 flex-col">
    <AnimatePresence initial={false}>
      {open ? <motion.div key="picker" ref={panel} className="min-w-0 overflow-hidden"
        initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}
        transition={spring("smooth", reduce)}>
        <PutInMealPicker recipe={recipe} {...placement} onClose={() => setOpen(false)} />
      </motion.div> : <Button key="trigger" ref={trigger} variant="primary" block disabled={disabled} aria-expanded={false}
        onClick={() => setOpen(true)}>
        Put it in a meal</Button>}
    </AnimatePresence>
  </div>;
}
