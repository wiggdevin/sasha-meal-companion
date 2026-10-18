"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import Button from "@/components/ui/Button";
import Fold from "@/components/ui/Fold";
import RuleMark, { RULE_MARK_LABEL } from "@/components/ui/RuleMark";
import { ruleMarkReason } from "@/lib/rule-mark";
import { COMMIT_FEEDBACK_MS } from "@/components/ui/ActionFeedback";
import { confirmHaptic } from "@/lib/haptics";
import Sheet from "@/components/Sheet";
import { MacroLine } from "@/components/nutrition/MacroText";
import { accountHandle, assertCurrent } from "@/lib/device/account";
import { saveRecipeEatenSlot } from "@/lib/plan-day-client";
import { eatenRecipeSnapshot } from "@/lib/recipes/eaten-snapshot";
import { loadAcceptedRecipeSelections } from "@/lib/recipes/accepted-client";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { RuleMark as RuleMarkValue, SlotId } from "@/lib/types";
import Notice from "@/components/ui/Notice";
import { dayName, localDate } from "@/lib/recipes-hub/put-in-meal";

/** "Today", "Tomorrow" or the weekday, as the rest of the app names a day. */
function eatenDay(date: string): string {
  const name = dayName(date, localDate());
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function sameSelection(a: AcceptedRecipeSelection, b: AcceptedRecipeSelection | null | undefined): boolean {
  return Boolean(b && a.id === b.id && a.recipeRevisionId === b.recipeRevisionId
    && a.planRevision === b.planRevision && a.servingFraction === b.servingFraction);
}

/**
 * Explicit actual-serving confirmation before Today's eaten snapshot is written.
 *
 * `ruleMark` is the slot's current mark (resolveDay), shown before confirming; it never blocks the
 * log. The server answers the eaten write with the recipe's mark under the CURRENT rules: with one,
 * the sheet stays open on it — the button confirms "Logged" in place, then becomes Done — because
 * eaten history is never marked again on the card. Without one, the sheet closes as before.
 */
export default function RecipeEatenConfirm({ selection, currentSelection, date, slotId, ruleMark, onClose, onLogged }: {
  selection: AcceptedRecipeSelection; date: string; slotId: SlotId;
  currentSelection?: AcceptedRecipeSelection | null;
  ruleMark?: RuleMarkValue | null;
  onClose: () => void; onLogged: () => void;
}) {
  const [fraction, setFraction] = useState(String(selection.servingFraction));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server's mark on a log that has landed; the sheet then only confirms and closes. */
  const [logged, setLogged] = useState<RuleMarkValue | null>(null);
  const [confirming, setConfirming] = useState(false);
  const loggedRef = useRef(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), COMMIT_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  // Once logged, every way out is "logged", so Today re-reads the day.
  const close = () => (loggedRef.current ? onLogged() : onClose());
  const visibleSelection = useRef(currentSelection);
  const mounted = useRef(true);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    visibleSelection.current = currentSelection;
    if (currentSelection !== undefined && !sameSelection(selection, currentSelection)) {
      if (loggedRef.current) onLogged(); else onClose();
    }
  }, [selection, currentSelection, onClose, onLogged]);
  let estimated: ReturnType<typeof eatenRecipeSnapshot> | null = null;
  try { if (fraction.trim()) estimated = eatenRecipeSnapshot(selection, Number(fraction)); }
  catch { /* Missing accepted evidence stays missing; confirmation reports the exact reason. */ }
  async function confirm() {
    const actual = Number(fraction);
    if (!fraction.trim() || !Number.isFinite(actual) || actual <= 0 || actual > 20) {
      setError("Enter a positive amount up to 20 servings."); return;
    }
    let account;
    try { account = accountHandle(); }
    catch { setError("Sign in to save what you ate."); return; }
    setBusy(true); setError(null);
    try {
      if (currentSelection !== undefined && !sameSelection(selection, currentSelection)) {
        throw new Error("This plan changed. Open the meal again before logging it.");
      }
      const latest = await loadAcceptedRecipeSelections(date, date);
      assertCurrent(account);
      if (!mounted.current || (visibleSelection.current !== undefined
        && !sameSelection(selection, visibleSelection.current))) return;
      if (!sameSelection(selection, latest.find((row) => row.localDate === date && row.slotId === slotId))) {
        onClose(); return;
      }
      eatenRecipeSnapshot(selection, actual); // Honest early evidence error; server computes the stored snapshot.
      const saved = await saveRecipeEatenSlot(date, slotId, selection, actual, requestId.current);
      assertCurrent(account);
      if (!saved?.ruleMark) { onLogged(); return; }
      loggedRef.current = true;
      setLogged(saved.ruleMark);
      setConfirming(true);
      confirmHaptic();
    } catch (cause) {
      try { assertCurrent(account); }
      catch { return; }
      setError(cause instanceof Error ? cause.message : "The eaten mark did not save. Try again.");
    } finally { setBusy(false); }
  }
  const shownMark = logged ?? ruleMark ?? null;
  return <Sheet title={`Log ${selection.recipeName}`} subtitle={`${eatenDay(date)} · Meal ${slotId.slice(5)}`} onClose={close}>
    <div className="flex flex-col gap-3 px-1 pb-4">
      <p className="m-0 text-sm">Planned: {selection.servingFraction} serving{selection.servingFraction === 1 ? "" : "s"}. Enter what you actually ate. Your planned amount stays the same.</p>
      <label className="text-sm">Servings eaten<input type="number" className="well mt-1 min-h-11 w-full px-3"
        min="0.01" max="20" step="0.01" value={fraction}
        disabled={busy || logged !== null} onChange={(event) => {
          requestId.current = crypto.randomUUID();
          setFraction(event.target.value);
        }} /></label>
      {estimated && <p className="ground-muted m-0 text-sm">Nutrition scaled from your accepted portion: <MacroLine label="word" values={estimated.macros} />. {Object.values(selection.nutritionSnapshot).some((value) => value.status === "estimated") ? "Estimated nutrition." : "Based on the accepted nutrition snapshot."}</p>}
      <AnimatePresence initial={false}>
        {shownMark && <Fold key="rule-mark"><div data-recipe-rule-mark={shownMark.verdict} className="pb-1">
          <RuleMark mark={shownMark} /></div></Fold>}
      </AnimatePresence>
      {/* Focus stays on the button, whose own region says only "Logged": the verdict and its reason
          are announced once here, in a status region that is in the page before they arrive. */}
      <p className="sr-only" role="status" data-recipe-rule-status="">
        {logged ? `${RULE_MARK_LABEL[logged.verdict]}: ${ruleMarkReason(logged)}` : ""}</p>
      {/* One primary throughout, so focus stays on it: it confirms "Logged" in place, then reads Done. */}
      <div className="flex gap-2"><Button variant="primary" status={logged && confirming ? "success" : "idle"}
        confirmLabel="Logged" disabled={!logged && (busy || !fraction.trim() || !Number.isFinite(Number(fraction))
          || Number(fraction) <= 0 || Number(fraction) > 20)}
        onClick={logged ? onLogged : () => void confirm()}>{logged ? "Done" : busy ? "Saving…" : "Confirm eaten amount"}</Button>
        {!logged && <Button disabled={busy} onClick={onClose}>Cancel</Button>}</div>
      {error && <Notice tone="error" title={error} />}
    </div>
  </Sheet>;
}
