"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CatalogRecipeResults from "@/components/CatalogRecipeResults";
import Sheet from "@/components/Sheet";
import { composedActions } from "@/components/CoachComposedCard";
import { formatTime } from "@/components/SlotCard";
import { postTurn, type CoachClientTurnResponse } from "@/lib/coach-client";
import { AccountChanged, assertCurrent, currentAccountOrNull,
  type AccountHandle } from "@/lib/device/account";
import type { CoachTurnRequest } from "@/lib/coach/types";
import { planTurnFields, type ComponentScope } from "@/components/plan/turn-scope";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { Macros, Provenance, ResolvedSlot } from "@/lib/types";
import { useRecipeAccess } from "@/lib/recipe-access-client";
import { searchCatalogRecipes } from "@/lib/recipe-catalog-client";
import { recipesJudgedNow, useRecipeReader } from "@/lib/recipes/recipe-freshness";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";
import { InspireError, inspireFromUrl } from "@/lib/plan/inspire-client";
import { readPlanDocument } from "@/lib/plan/document-client";
import { documentMeal } from "@/lib/plan/document-meal";
import type { DocumentPlanResult } from "@/lib/plan/document-types";
import type { InspireResult, PlanSource } from "@/lib/plan/inspire-types";
import PlanComposer from "@/components/plan/PlanComposer";
import Button from "@/components/ui/Button";
import { ASSISTANT_NAME } from "@/lib/brand";
import { occasionAt } from "@/lib/meals/occasion";
import { composedMealSignalEvents, PLAN_SHEET_RANKING_VERSION }
  from "@/components/signals/composed-meal-signals";
import { foodSignal, sendFoodSignals } from "@/lib/foods/signals-client";
import { roomLeftLine } from "@/components/plan/room-left";
import Thinking from "@/components/ui/Thinking";
import Notice from "@/components/ui/Notice";
import PlanSheetHeader from "@/components/plan/PlanSheetHeader";
import { EMPTY_BODY, EMPTY_TITLE, planFailure, replyTone, selectable } from "@/components/plan/plan-notices";
import IdeaCard from "@/components/plan/IdeaCard";
import PhotoResult, { readOf, SwitchLine } from "@/components/plan/PhotoResult";
import { usePlanPhoto, type PhotoSource } from "@/components/plan/usePlanPhoto";
import { usePlaceSlot } from "@/components/plan/usePlaceSlot";
import PanelReview from "@/components/plan/PanelReview";
import DocumentPlan, { DocumentOther } from "@/components/plan/DocumentPlan";
import AiLabel from "@/components/ui/AiLabel";
import PhotoPrivacyNotice from "@/components/ui/PhotoPrivacyNotice";
import { inspirePrompt, inspireSource, looksLikeUrl, notAgainList, pickPrompt, rankPicks,
  recipeSearchFor, wishPrompt, type PlanAsk as Ask, type QuickPick } from "@/lib/plan/quick-picks";

export function planLabel(slot: Pick<ResolvedSlot, "slot" | "label">): string {
  return slot.slot.startsWith("meal-") ? `Meal ${slot.slot.slice(5)}` : slot.label;
}

/** The opening ask, kept for older callers: "Choose for me" with the starter's own need. */
export { planFailure } from "@/components/plan/plan-notices";

export function planPrompt(slot: string, label: string, date: string, pick: QuickPick = "Choose for me") {
  return pickPrompt(pick, label, slot, date);
}

/** A card turn: the coach request plus the component scope the backend accepts (PR #355). */
type PlanTurn = CoachTurnRequest & { scope?: ComponentScope };


/**
 * Plan one slot. Options appear on open ("Choose for me"); the person says yes (Add) or no (Not
 * this) and the next ideas come by themselves. One-tap picks, a free "ask for anything" box, a
 * photo of a fridge, recipe page or dish, or a pasted recipe link all become the same coach planning
 * turn, so Jev's intent pass and the account's rules shape every card. A photo of a plate offers to
 * log it to this meal; a menu shows the three best picks (components/plan/PhotoResult.tsx). The "+"
 * reads an uploaded meal plan, recipe or menu file: a menu or recipe joins those same paths, and a
 * meal plan shows its matched meal for "Use for this meal" (components/plan/DocumentPlan.tsx).
 * Complete recipes show beside them when the recipe pilot is on.
 *
 * `mode="log"` ("Ate something else" on a planned card) opens camera first with an "I had …" box,
 * and sends no planning turn.
 */
export default function PlanSheet({ date, slot, target, onClose, onPlaced, mode = "plan", onLogged }: {
  date: string; slot: ResolvedSlot; target: Macros | undefined;
  onClose: () => void; onPlaced: () => void;
  mode?: "plan" | "log";
  /** A log from this panel landed on `filedDate` under this slot. */
  onLogged?: (filedDate: string) => void;
}) {
  const recipeAccess = useRecipeAccess();
  const [response, setResponse] = useState<CoachClientTurnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [onlyEats, setOnlyEats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<QuickPick | null>("Choose for me");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [found, setFound] = useState<InspireResult | null>(null);
  const [doc, setDoc] = useState<((DocumentPlanResult | { kind: "other" }) & { provenance?: Provenance }) | null>(null);
  const [recipes, setRecipes] = useState<{ query: string; list: RecipeCandidate[] } | null>(null);
  const [placingWish, setPlacingWish] = useState<string | null>(null);
  const [openingAccount] = useState(currentAccountOrNull);
  const [tz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const label = planLabel(slot);
  // One id per batch of ideas shown (a fresh `response` is a fresh slate): the Plan sheet's own
  // "Not this" / "Add" signals (Phase 18 W6) share it for as long as these same ideas are on screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slateId = useMemo(() => crypto.randomUUID(), [response]);
  const picks = useMemo(() => rankPicks(slot.time, target, date), [slot.time, target, date]);
  const recipesOn = recipeAccess.enabled && slot.slot.startsWith("meal-");
  const threadId = useRef<string | null>(null);
  const pending = useRef<PlanTurn | null>(null);
  const pendingEatsOnly = useRef(false);
  const requestBusy = useRef(false);
  const readingRef = useRef(false);
  const lastAsk = useRef<Ask>({ kind: "pick", pick: "Choose for me" });
  const logMode = mode === "log";
  const photo = usePlanPhoto({ slot: slot.slot, date, time: slot.time, targetKcal: target?.kcal, onError: setError,
    onAccountChanged: onClose, onLogged: (filed) => { onLogged?.(filed); onClose(); } });
  // The idea a placement is in flight for: `added` fires only once usePlaceSlot's own onPlaced
  // confirms the write actually applied (Sol review r1 WARN) — never on the tap alone, which
  // usePlaceSlot's in-flight lock and server round trip can still refuse or fail. Cleared on
  // every placer outcome (success or error) and before a non-idea placement (a document's "Use
  // for this meal") starts, so a failed idea's stale ref can never attach its `added` signal to a
  // later, unrelated placement through the same placer (Sol review r2 BLOCK).
  const placingMeal = useRef<{ meal: ComposedMeal; tappedAt: Date } | null>(null);
  const placer = usePlaceSlot({ tz, account, onClose,
    // usePlaceSlot also calls this with `null` at the very start of every placement, to clear a
    // previous error banner — not a failure, so only a real (truthy) message means this
    // placement is actually done and its ref should be released.
    onError: (message) => { if (message) placingMeal.current = null; setError(message); },
    onPlaced: () => {
      const placed = placingMeal.current;
      placingMeal.current = null;
      if (placed) sendIdeaSignal("added", placed.meal, placed.tappedAt);
      onPlaced();
    } });
  const slotAction = (meal: ComposedMeal) =>
    composedActions(meal, slot.slot, { date, at: slot.time }, () => crypto.randomUUID()).slot;

  function account(): AccountHandle | null {
    try {
      if (!openingAccount) throw new AccountChanged();
      assertCurrent(openingAccount);
      return openingAccount;
    } catch { onClose(); return null; }
  }

  /** `onAccept` runs only once this turn has taken the single request slot, so whatever it commits
   *  (the ask, the chip, the recipe list) always describes the turn the cards will answer. */
  async function request(text: string, retry = false, eatsOnly = false, initialPlan = false,
    data: { planSource?: PlanSource; planSkipped?: string[]; onAccept?: () => void } = {}): Promise<boolean> {
    if (requestBusy.current) return false;
    const h = account();
    if (!h) return false;
    const { planSource, planSkipped, onAccept } = data;
    const turn: PlanTurn = retry && pending.current ? pending.current : {
      threadId: threadId.current, messageId: crypto.randomUUID(), text, tz,
      // The card's slot and viewed date: a component scope, or the older Plan-sheet fields
      // (components/plan/turn-scope.ts). Only the automatic opening asks for generic options.
      ...planTurnFields(slot.slot, date, initialPlan),
      // Foods a photo or link named, and cards said no to, travel as data, never inside `text`.
      ...(planSource ? { planSource } : {}),
      ...(planSkipped?.length ? { planSkipped } : {}),
    };
    requestBusy.current = true;
    onAccept?.();
    pending.current = turn;
    if (!retry) pendingEatsOnly.current = eatsOnly;
    setLoading(true);
    setError(null);
    setRetryAvailable(false);
    try {
      const answer = await postTurn(turn, { account: h });
      assertCurrent(h);
      threadId.current = answer.threadId;
      pending.current = null;
      setResponse(answer);
      setOnlyEats(pendingEatsOnly.current);
      return true;
    } catch (caught) {
      if (caught instanceof AccountChanged) { onClose(); return false; }
      const failure = planFailure(caught);
      setError(failure.message);
      setRetryAvailable(failure.retryable);
      return false;
    } finally {
      requestBusy.current = false;
      setLoading(false);
    }
  }

  // One reader (lib/recipes/recipe-freshness.ts): a new ask aborts the search before it, only the
  // newest lands, and a rule change reads the shown recipes again ("Checking…" meanwhile).
  const { reader: recipeReader, stale: recipesStale } = useRecipeReader<{ query: string; list: RecipeCandidate[] }>({
    apply: setRecipes, judged: (found) => recipesJudgedNow(found.list) });

  /**
   * Complete recipes for a new ask; quiet on failure, the coach's cards still answer. The previous
   * ask's list is cleared at once, so it can never be planned into this slot as an answer to this
   * ask; a late result from an older search is ignored.
   */
  function findRecipes(ask: Ask) {
    if (!recipesOn) return;
    const search = recipeSearchFor(ask);
    recipeReader.clear();
    setRecipes(null);
    if (!search) return;
    const key = JSON.stringify(search);
    void recipeReader.read((signal) => searchCatalogRecipes({ ...search, limit: 3 }, signal)
      .then((result) => ({ query: key, list: result.recipes })));
  }

  /**
   * One planning turn for an ask, steering away from the cards already said no to. A new ask
   * (`fresh`) commits itself — lastAsk, its recipe search and `onAccept` — only if the turn is
   * taken; a tap while another turn is in flight changes nothing. A refill keeps the ask it replays.
   */
  function sendAsk(ask: Ask, skippedNow: readonly string[] = [], fresh?: () => void): Promise<boolean> {
    const planSkipped = notAgainList(skippedNow);
    const onAccept = fresh && (() => { lastAsk.current = ask; findRecipes(ask); fresh(); });
    if (ask.kind === "pick") {
      return request(pickPrompt(ask.pick, label, slot.slot, date, skippedNow), false,
        ask.pick === "Use what I have", false, { planSkipped, onAccept });
    }
    if (ask.kind === "wish") {
      return request(wishPrompt(ask.wish, label, slot.slot, date, skippedNow), false, false, false,
        { planSkipped, onAccept });
    }
    return request(inspirePrompt(ask.found, label, slot.slot, date, skippedNow), false, false, false,
      { planSource: inspireSource(ask.found), planSkipped, onAccept });
  }

  useEffect(() => {
    if (recipeAccess.loading || logMode) return;
    // Defer past Strict Mode's test mount, so one opening sends one first turn.
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const ask: Ask = { kind: "pick", pick: "Choose for me" };
      void request(planPrompt(slot.slot, label, date), false, false, true,
        { onAccept: () => { lastAsk.current = ask; findRecipes(ask); } });
    });
    return () => { live = false; };
    // One sheet opening has one fixed date and slot. Today keys it when either changes. Log mode
    // never sends a planning turn; a switch out of it would.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, slot.slot, recipeAccess.loading, logMode]);

  /** No turn in flight and no photo or link being read: only then may a tap start a new ask. */
  const idle = () => !requestBusy.current && !readingRef.current && !photo.busy();

  function choose(pick: QuickPick) {
    if (!idle()) return;
    void sendAsk({ kind: "pick", pick }, [], () => { setActive(pick); setSkipped([]); setFound(null); setDoc(null); });
  }

  /** `onTaken` runs only once the read's planning turn is accepted (the composer clears then). */
  async function readSource(source: PhotoSource | { url: string } | { document: File }, onTaken?: () => void) {
    if (!idle()) return;
    const h = account();
    if (!h || reading || loading) return;
    readingRef.current = true;
    setReading("url" in source ? "Reading that recipe…" : "document" in source ? "Reading your file…"
      : "Reading your photo…");
    setError(null); setRetryAvailable(false);
    try {
      const result = "url" in source ? await inspireFromUrl(h, source.url, date)
        : "document" in source ? await readPlanDocument(h, source.document,
          { localDate: date, slot: slot.slot, slotTime: slot.time, targetKcal: target?.kcal })
          : await photo.read(h, source);
      assertCurrent(h);
      if (!result) return;
      if ("document" in source) photo.forget();
      setDoc(null);
      // A meal plan (or a file with nothing usable) is shown in place; nothing writes until a tap.
      if (result.kind === "meal_plan" || result.kind === "other") {
        setFound(null); setActive(null); photo.setShown(null); setDoc(result);
        return;
      }
      // A plate or a menu is one next step on its own: log it, or pick and log. No planning turn.
      if (result.kind === "plate" || result.kind === "menu") {
        setFound(null); setActive(null); photo.setShown(result); onTaken?.();
        return;
      }
      photo.setShown(null);
      if (result.ingredients.length === 0 && !result.title) {
        setError("I couldn’t spot any food there. Try a closer photo or another link.");
        return;
      }
      readingRef.current = false;
      setReading(null);
      // Another turn took the slot while this was being read: nothing changes, and it says so.
      const sent = await sendAsk({ kind: "inspire", found: result }, [],
        () => { setActive(null); setSkipped([]); setFound(result); onTaken?.(); });
      if (!sent && requestBusy.current) setError("Still finding meal ideas. Try that again in a moment.");
    } catch (caught) {
      if (caught instanceof AccountChanged) { onClose(); return; }
      setError(caught instanceof InspireError ? caught.message : "Couldn’t read that. Try again.");
    } finally { readingRef.current = false; setReading(null); }
  }

  /** After the tap has already done its work: never blocks, never surfaces an error. `slate` is
   *  this showing's full offered set (`response.composed`, not the shrinking `choices`), so every
   *  event under this slateId reports the same slate — a "Not this" said after an earlier one in
   *  the same showing must not report a smaller, inconsistent offer (Sol review r1 WARN).
   *  `tappedAt` defaults to the call's own time (right for "not_this", which never waits on a
   *  write); `place` below passes the tap's own time explicitly, since its "added" fires only
   *  once the placement's save resolves, which a slow save could push past midnight otherwise
   *  (Sol review r4 WARN — the swap sheet already carries this same fix). */
  function sendIdeaSignal(kind: "added" | "not_this", meal: ComposedMeal, tappedAt: Date = new Date()) {
    const events = composedMealSignalEvents({ slateId, surface: "plan_sheet", kind,
      slate: shownIdeas,
      chosen: meal, occasion: occasionAt(slot.time, { slot: slot.slot }),
      rankingVersion: PLAN_SHEET_RANKING_VERSION });
    // sendFoodSignals rethrows AccountChanged (lib/device/account.ts rethrowAccountChanged); the
    // tap already succeeded, so that must never become an unhandled rejection (Sol review r1).
    if (events.length) void sendFoodSignals(events.map((event) => foodSignal(event, tappedAt))).catch(() => {});
  }

  function place(meal: ComposedMeal) {
    if (!selectable(meal)) return;
    setPlacingWish(meal.wish);
    placingMeal.current = { meal, tappedAt: new Date() };
    void placer.place(slotAction(meal), meal.wish);
  }

  // A plate, menu or meal-plan result, or a log waiting to be checked, is the one next step: the
  // planning cards step aside under it.
  const reviewing = photo.review !== null;
  const aside = Boolean(photo.shown || doc || reviewing);
  // Every idea this turn's reply actually could show as a card — eligible and, under "Use what I
  // have", Eats-only — independent of whether a card is currently hidden behind a photo/document
  // flow (`aside`) or has since been skipped. This, not the shrinking `choices` below, is this
  // showing's offered slate: it must never claim a meal the reply never made selectable, and it
  // must stay the same set for every signal under one slateId (Sol review r2 BLOCK — `aside` and
  // `skipped` are UI state, not part of what the turn offered).
  const shownIdeas = (response?.composed ?? []).filter((meal) => selectable(meal)
    && (!onlyEats || meal.allItemsOnEats === true));
  const choices = aside ? [] : shownIdeas.filter((meal) => !skipped.includes(meal.wish));
  const reply = response?.messages.findLast((message) => message.role === "assistant")?.content;
  const busy = loading || Boolean(reading) || placer.placing || photo.logging !== null;
  const tone = replyTone(reply);
  const empty = !loading && Boolean(response) && !aside && choices.length === 0;

  function skip(meal: ComposedMeal) {
    if (!idle()) return;
    const next = [...skipped, meal.wish];
    setSkipped(next);
    sendIdeaSignal("not_this", meal);
    // Every card said no to: the next three come by themselves, steering away from these.
    // The refill replays the ask these cards answered (pick, wish, or photo/link foods), not a
    // generic "Surprise me", and keeps that ask's Eats-only filter.
    if (choices.length === 1) void sendAsk(lastAsk.current, next);
  }

  /**
   * Every log from this panel ("I had …", a plate, a menu pick) goes through here: no log while
   * another is in flight or a read or turn is running. `photo.busy()` is a ref set before the first
   * await, so a second tap in the same frame is refused too (audit b4b #3).
   */
  function logOnce(run: (h: AccountHandle) => void) {
    if (!idle()) return;
    const h = account();
    if (h) run(h);
  }

  function submit() {
    const entered = draft.trim();
    if (!entered || busy || !idle()) return;
    // The composer clears only once the ask is actually taken; a refused one keeps its words.
    const clear = () => setDraft((current) => current.trim() === entered ? "" : current);
    if (logMode) {
      // The words stay in the box while what they will log is checked below it.
      logOnce((h) => { void photo.reviewText(h, entered); });
      return;
    }
    if (looksLikeUrl(entered)) { void readSource({ url: entered }, clear); return; }
    void sendAsk({ kind: "wish", wish: entered }, [],
      () => { setActive(null); setSkipped([]); setFound(null); setDoc(null); })
      .then((ok) => { if (ok) clear(); });
  }

  return (
    <Sheet title={`${logMode ? "Log" : "Plan"} ${label} · ${formatTime(slot.time)}`} onClose={onClose}
      header={<PlanSheetHeader mode={mode} label={label} slot={slot.slot} time={slot.time}
        clock={formatTime(slot.time)} target={target} />}
      // Inside the meal card the card above is the header: the flow says only what it is and, when
      // planning, the room left for this meal (never the meal's own numbers).
      inset={{ label: logMode ? "Log what you ate" : `Plan with ${ASSISTANT_NAME}` }}
      subtitle={logMode ? "What you ate takes the planned meal’s place." : roomLeftLine(target)}>
      <div className="flex min-w-0 flex-col gap-3">
        {/* A horizontal carousel owns only x (DESIGN.md §Layout, scroll ownership): a vertical drag
            on it still scrolls the page. It bleeds to the tray's edges, with room below for the chosen
            chip's shadow, which a scroller would otherwise cut into a band. */}
        {!logMode && <div role="group" aria-label="Quick picks"
          className="-mx-4 -mb-5 -mt-1 flex min-w-0 snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain px-4 pb-5 pt-1">
          {picks.map((pick) => <Button key={pick} size="sm" disabled={busy} className="snap-start"
            variant={active === pick ? "primary" : "secondary"}
            aria-pressed={active === pick} onClick={() => choose(pick)}>
            {pick}
          </Button>)}
        </div>}
        <PlanComposer draft={draft} onDraft={setDraft} onSubmit={submit} busy={busy}
          onPhoto={(file) => { void readSource(logMode ? { file, as: "plate" } : { file }); }}
          onDocument={(file) => { void readSource({ document: file }); }}
          photoNotice={<PhotoPrivacyNotice />}
          {...(logMode ? { label: "What you had", placeholder: "I had…", cameraFirst: "Snap what you ate",
            hint: "Snap your plate, tap + for a meal plan, or tell me what you had." }
            : { hint: "Ask for anything, paste a recipe link, or tap + for a photo or a meal plan." })} />
        {(loading || reading) && <Thinking label={reading ?? "Finding meal ideas…"} />}
        {placer.savePending && <Notice tone="info" title="Still saving this meal…" />}
        {photo.review && <PanelReview key={photo.review.draft.draftId} pending={photo.review} label={label}
          onConfirm={async (edits) => { const h = account(); return h ? photo.confirm(h, edits) : null; }}
          onCancel={photo.cancelReview} onDone={(filed) => { onLogged?.(filed); onClose(); }} />}
        {photo.shown && !reading && !reviewing && <PhotoResult result={photo.shown} label={label}
          targetKcal={target?.kcal} busy={busy} logging={photo.logging}
          onLogPlate={(factor) => logOnce((h) => photo.reviewPlate(h, factor))}
          onPick={(pick) => logOnce((h) => photo.reviewPick(h, pick))} />}
        {doc && !reading && (doc.kind === "other" ? <DocumentOther provenance={doc.provenance} /> : <DocumentPlan result={doc} label={label}
          busy={busy} placing={placer.placing} onUse={() => { if (doc.match) {
            // Not an idea pick: never attach a stale idea's `added` signal to this placement.
            placingMeal.current = null;
            void placer.place(slotAction(documentMeal(doc.match, slot.slot, target)), doc.match.title); } }} />)}
        {found && !reading && <p className="m-0 text-caption text-graphite">
          {found.title ? `From “${found.title}”` : "From your photo"}
          {found.ingredients.length > 0 && `: ${found.ingredients.slice(0, 6).join(", ")}`}
          <AiLabel provenance={found.provenance} className="ml-1.5 align-middle" />
        </p>}
        {photo.photo && !reading && !reviewing && (photo.shown || found) && <SwitchLine busy={busy}
          current={readOf((photo.shown ?? found)!.kind)}
          onSwitch={(read) => { void readSource({ as: read }); }} />}
        {error && <Notice tone="error" title={error} action={retryAvailable ? { label: "Try again", disabled: loading,
          onClick: () => { void request(pending.current?.text ?? "", true); } } : undefined} />}
        {reply && !loading && !aside && <div className="flex min-w-0 flex-col gap-1.5">
          {tone ? <Notice tone={tone} title={reply}>{empty ? EMPTY_BODY : undefined}</Notice>
            : <p className="m-0 text-body-md text-charcoal">{reply}</p>}
          <AiLabel provenance={response?.provenance} className="self-start" />
        </div>}
        {empty && !tone && <Notice tone="neutral" title={EMPTY_TITLE}>{EMPTY_BODY}</Notice>}
        {!loading && choices.map((meal, index) => <IdeaCard key={`${meal.wish}-${index}`} meal={meal}
          provenance={response?.provenance}
          label={label} busy={busy} placing={placer.placing && placingWish === meal.wish}
          onPlace={() => place(meal)} onSkip={() => skip(meal)} />)}
        {recipesOn && recipes && recipes.list.length > 0 && <section aria-label="Full recipes"
          className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 text-caption font-medium text-graphite">Full recipes that fit</h3>
          <CatalogRecipeResults blockId={`plan:${slot.slot}:${recipes.query}`}
            sourceEpoch={openingAccount?.epoch} recipes={recipes.list} stale={recipesStale}
            initialDate={date} initialSlotId={slot.slot} nested
            onPlanned={() => { onPlaced(); onClose(); }} />
        </section>}
      </div>
    </Sheet>
  );
}
