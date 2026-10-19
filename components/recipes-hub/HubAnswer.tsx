"use client";
/**
 * What the recipe widget shows under its ask box: the catalog's matching recipes first, then the
 * coach's words and composed meals, a Log it confirmation for a meal already eaten or a portion the
 * coach sized, and a plate or menu photo's own log step. A log always shows its matched foods first
 * (PanelReview, U23) and writes only from that review's Log it. A composed meal's action applies once per tap, for the account the widget opened as, and a
 * result that lands after an account change or after the widget closed is dropped (audit
 * 2026-10-04, the usePlaceSlot pattern).
 *
 * Audit r4: the lock is a module-level flight per account (components/single-flight.ts), so it
 * outlives the widget. The hub's Close is disabled while it is up (RecipeHub reads the same
 * prefix), and a widget opened again cannot send a second action before the first lands. There is
 * no live region around the answer: Thinking, each Notice and the coach's reply speak for
 * themselves, so recipe names are not read out on every update and Thinking is not read twice.
 *
 * The outcome outlives the widget too (audit f2 MAJOR): "Done."/the error is recorded on the same
 * account prefix the flight held, so a widget that remounts (the carousel's card collapsing to
 * "Build my own" and back, say) after an apply settled still shows what happened, instead of
 * silence over a save that already went out. RecipeHub clears it when the hub itself closes.
 */
import { useEffect, useRef, useState } from "react";
import { flightOutcome, fly, flyingUnder, setFlightOutcome, useFlying } from "@/components/single-flight";
import CatalogRecipeResults from "@/components/CatalogRecipeResults";
import AiLabel from "@/components/ui/AiLabel";
import CoachComposedCard from "@/components/CoachComposedCard";
import PhotoResult, { SwitchLine } from "@/components/plan/PhotoResult";
import PanelReview from "@/components/plan/PanelReview";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
import Thinking from "@/components/ui/Thinking";
import type { useHubAsk } from "@/components/recipes-hub/useHubAsk";
import type { HubDay } from "@/components/recipes-hub/useHubDay";
import type { CoachAction } from "@/lib/coach/actions";
import { applyCoachAction } from "@/lib/coach/apply-client";
import { AccountChanged, assertCurrent, currentAccountOrNull, isCurrent, type AccountHandle } from "@/lib/device/account";
import { portionQuestion, portionToLog } from "@/lib/recipes-hub/hub";

type Ask = ReturnType<typeof useHubAsk>;

const ACCOUNT_CHANGED = "Account changed. Close and reopen.";
const NOT_SAVED = "That didn’t save. Try again.";

/** The prefix every composed-meal apply of this account holds while it is on the wire. */
export const hubApplyPrefix = (userId: string | null | undefined) => `hub-apply:${userId ?? "-"}:`;

/**
 * Applies `action` as `h`, once: null, and nothing sent, while another hub apply of `h` is on the
 * wire. `applyCoachAction` binds the account that is current when it is called, so `h` is asserted
 * in the same tick, just before the call, and checked again before the result is believed.
 *
 * `hubOpen` is read only at the moment the outcome would be recorded (audit g1 MINOR): the widget
 * (HubAnswer) that started this can unmount and remount on its own — "Build my own" — well before
 * the hub itself closes, so this must track the hub's own lifetime, not the widget's.
 */
export function applyAs(h: AccountHandle, action: CoachAction, tz: string, hubOpen: () => boolean): Promise<string> | null {
  const prefix = hubApplyPrefix(h.userId);
  if (flyingUnder(prefix)) return null;
  return fly(`${prefix}${action.actionId}`, async () => {
    let text: string;
    try {
      assertCurrent(h);
      const result = await applyCoachAction(action, { tz });
      text = !isCurrent(h) ? ACCOUNT_CHANGED : result.status === "applied" ? "Done." : result.reason || NOT_SAVED;
    } catch (caught) {
      text = caught instanceof AccountChanged || !isCurrent(h) ? ACCOUNT_CHANGED : NOT_SAVED;
    }
    // Kept so a widget that remounts after this settled still shows it (audit f2 MAJOR) — unless
    // the hub itself is gone, which already forgot this prefix on its way out (audit g1 MINOR).
    if (hubOpen()) setFlightOutcome(prefix, text);
    return text;
  });
}

function LogConfirm({ text, label, busy, onLog, onCancel }: {
  text: string; label: string; busy: boolean; onLog: () => void; onCancel?: () => void;
}) {
  return <section aria-label="Log this" className="well flex flex-col gap-2 p-3">
    <p className="m-0 text-body-md text-charcoal">Log “{text}” to {label}?</p>
    <p className="m-0 text-tiny text-muted">The amounts are matched to foods and shown to you first; nothing is saved until you log it.</p>
    <div className="flex gap-2">
      <Button variant="primary" className="flex-1" status={busy ? "pending" : undefined}
        onClick={onLog}>Check it</Button>
      {onCancel && <Button variant="tertiary" disabled={busy} onClick={onCancel}>Not now</Button>}
    </div>
  </section>;
}

export default function HubAnswer({ ask, day, sourceEpoch, onPlanned, hubAlive }: {
  ask: Ask; day: HubDay; sourceEpoch?: number; onPlanned?: () => void;
  /** The hub's own lifetime, read at apply-settle time (audit g1 MINOR). Defaults to "always open" for callers (tests) that don't track one. */
  hubAlive?: { current: boolean };
}) {
  const [owner] = useState(() => currentAccountOrNull()?.userId ?? null);
  const [applied, setApplied] = useState<string | null>(null);
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const { response, catalog, asked, photo } = ask;
  const reply = response?.messages.findLast((message) => message.role === "assistant")?.content;
  const composed = (response?.composed ?? []).filter((meal) => meal.items.length > 0);
  const portion = response && asked && composed.length === 0 && portionQuestion(asked.text)
    ? portionToLog(response.suggestions) : null;
  const logging = photo.logging !== null;
  const saving = useFlying(hubApplyPrefix(owner));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A widget that mounts after an apply already settled (closed mid-save, reopened) shows that
  // outcome instead of nothing — and so does one that mounted WHILE it was still in flight:
  // `saving` going back to false is exactly the signal that an outcome may now exist, since
  // `setFlightOutcome` is written before the flight's own lock clears (audit g1 MAJOR).
  useEffect(() => {
    if (saving) return;
    const outcome = flightOutcome<string>(hubApplyPrefix(owner));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (outcome !== undefined) setApplied(outcome);
  }, [saving, owner]);

  function apply(action: CoachAction) {
    const h = ask.account();
    if (!h) return;
    const flight = applyAs(h, action, tz, () => hubAlive?.current ?? true);
    if (!flight) return;
    setApplied("Saving…");
    void flight.then((text) => { if (mounted.current) setApplied(text); });
  }
  const shown = applied ?? (saving ? "Saving…" : null);

  return <div className="flex min-w-0 flex-col gap-3">
    {(ask.loading || ask.reading) && <Thinking size="inline"
      label={ask.reading ? "Reading your photo…" : "Finding recipes that fit…"} />}
    {/* Typed words being matched to foods: the confirm card is gone and the review not here yet. */}
    {ask.matching && !portion && <Thinking size="inline" label="Matching your foods…" />}
    {ask.error && <Notice tone="error" title={ask.error.message}
      action={ask.error.retryable ? { label: "Try again", onClick: ask.retry } : undefined} />}
    {ask.logged && <Notice tone="success" title={ask.logged} />}
    {ask.confirm && <LogConfirm text={ask.confirm} label={day.label} busy={logging}
      onLog={() => ask.logIt(ask.confirm!)} onCancel={ask.cancelConfirm} />}
    {photo.review && <PanelReview key={photo.review.draft.draftId} pending={photo.review} label={day.label}
      onConfirm={ask.confirmReview} onCancel={photo.cancelReview} onDone={ask.reviewDone} />}
    {photo.shown && !ask.reading && !photo.review && <PhotoResult result={photo.shown} label={day.label}
      targetKcal={day.remaining?.kcal} busy={ask.busy} logging={photo.logging}
      onLogPlate={(factor) => { const h = ask.account(); if (h) photo.reviewPlate(h, factor); }}
      onPick={(pick) => { const h = ask.account(); if (h) photo.reviewPick(h, pick); }}
      onSwitch={(read) => { void ask.rereadPhoto(read); }} />}
    {!photo.shown && ask.photoRead === "ingredients" && asked?.label === "Your photo" && !ask.loading && !ask.reading
      && <SwitchLine current="ingredients" busy={ask.busy} onSwitch={(read) => { void ask.rereadPhoto(read); }} />}
    {!ask.loading && catalog && catalog.length > 0 && <section aria-label="Recipes that match"
      className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-caption font-medium text-graphite">From the recipe catalog</h3>
      <CatalogRecipeResults blockId={`hub:${asked?.label ?? ""}`} sourceEpoch={sourceEpoch} stale={ask.catalogStale}
        recipes={catalog} initialDate={day.date} onPlanned={onPlanned} />
    </section>}
    {reply && !ask.loading && <p role="status" className="m-0 text-body-md text-charcoal">
      {reply}<AiLabel provenance={ask.madeBy} className="ml-1.5 align-middle" /></p>}
    {portion && !ask.logged && <LogConfirm text={portion} label={day.label} busy={logging}
      onLog={() => ask.logIt(portion)} />}
    {!ask.loading && composed.length > 0 && <section aria-label="Meals that fit" className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-caption font-medium text-graphite">Meals built to fit</h3>
      {composed.map((meal, index) => <div key={`${meal.wish}-${index}`} className="flex flex-col gap-1">
        <p className="m-0 text-body-md font-medium text-charcoal">{meal.wish}</p>
        <CoachComposedCard meal={meal} tz={tz} onAction={apply} provenance={ask.madeBy} />
      </div>)}
      {shown && <Notice tone={shown === "Done." ? "success" : shown === "Saving…" ? "info" : "error"}
        title={shown} />}
    </section>}
  </div>;
}
