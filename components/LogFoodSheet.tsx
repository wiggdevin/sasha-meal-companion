"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import CaptureRow, { closeThenCapture } from "@/components/CaptureRow";
import CatalogSearch from "@/components/CatalogSearch";
import FavoritesStrip from "@/components/FavoritesStrip";
import FoodDetailSheet from "@/components/FoodDetailSheet";
import LogFoodPortion from "@/components/LogFoodSheet.Portion";
import { RemoveIcon } from "@/components/LogFoodSheet.icons";
import { MacroFigure, MacroLine } from "@/components/nutrition/MacroText";
import ProjectedDayTotals, { type DayProjection } from "@/components/ProjectedDayTotals";
import Sheet, { Pill } from "@/components/Sheet";
import WorkingLine from "@/components/WorkingLine";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import SearchField from "@/components/ui/SearchField";
import { beginRun } from "@/lib/timing";
import { catalogSearchEnabled, getFoodDetail, offPlanFlags, toCachedRevision, type CatalogRow } from "@/lib/catalog-client";
import { captureActions } from "@/lib/capture-client";
import { portionPill, rowServingLine } from "@/lib/catalog/serving";
import type { CaptureMethod } from "@/lib/capture/flags";
import type { CachedPortion, CachedRevision } from "@/lib/db/catalog-cache";
import {
  dbFood, logPortionsFor, mineAsDb, searchFoods, type DbFood, type DbPortion,
} from "@/lib/food-db";
import type { FavoriteRow } from "@/lib/favorites";
import type { Food } from "@/lib/foods";
import type { FoodDetail } from "@/lib/server/catalog";
import { gramsForPortion } from "@/lib/log/grams";
import { resolveFoodRef, type FoodRefFailureReason } from "@/lib/log-client";
import { AccountChanged } from "@/lib/device/account";
import { localOnlyCard, preparePickedCommit, type LogPick } from "@/lib/log/picked-commit";
import { localOnlyMessage, pickForCard, sheetCard } from "@/components/LogFoodSheet.picks";
import { catalogCard, fmt } from "@/lib/log/catalog-card";
import { commitLogEntry, committedEntry, outcomeFor } from "@/lib/log-commit-client";
import { mealCard, sumMacros } from "@/lib/log/meal-card";
import {
  BADGE_MINE_CLASS, BADGE_MINE_STYLE, BADGE_USDA_CLASS, BADGE_USDA_STYLE,
  ROW_CLASS, ROW_META_CLASS, ROW_STYLE, ROW_TITLE_CLASS, SECTION_LABEL_CLASS,
} from "@/components/LogFoodSheet.styles";
import type { LoggedFood, Macros, SlotId } from "@/lib/types";
import KcalText from "@/components/ui/KcalText";
import Notice from "@/components/ui/Notice";
import { NUTRITION_UNCHECKED_COPY, PARTIAL_NOTE, commitNutritionUnchecked } from "@/lib/nutrition-display";

const FLAG_LABEL: Record<string, string> = { gluten: "gluten", dairy: "dairy", apple: "apple" };

/** The catalog "Log it" / "Add to meal" button: blocks a tap while grams or the food_ref are not
 *  ready, and — same as ScanConfirmSheet's `saving` guard — while a commit from the last tap is
 *  still in flight, so a second tap can never mint a second entry_id for the same food. */
export function canConfirmPortion(grams: number, foodRefId: string | null, submitting: boolean): boolean {
  return grams > 0 && foodRefId !== null && !submitting;
}

/** The "Log this meal" button: blocks an empty meal, and blocks a second tap while the last
 *  tap's commit is still in flight, so a slow request can never commit the same meal twice. */
export function canSaveMeal(itemCount: number, submitting: boolean): boolean {
  return itemCount > 0 && !submitting;
}

/** Marking, never hiding — the same sentence on the bundled and the catalog portion views. */
function offPlanLine(flags: string[]): string {
  return `Off-plan: ${flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}. Logging it is still the right call.`;
}

function newId(tag: string): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${tag}`;
}

type View = "search" | "portion" | "meal";

/**
 * Log a food, or log a whole meal made of several foods with a name and a
 * note. Search ~460 USDA foods plus their own list, pick a serving and how
 * many, see the macros. Off-plan foods (gluten, dairy, apple) are marked,
 * never hidden — an honest log is worth more than a tidy one.
 */
export default function LogFoodSheet({
  mode,
  mine,
  slot,
  projection,
  onAdd,
  onSomethingElse,
  onClose,
  onCapture,
  onScan,
  at,
}: {
  mode: "food" | "meal";
  mine: Record<string, Food>;
  /** Which slot a catalog entry belongs to — app/page.tsx passes the slot nearest the current time. */
  slot: SlotId;
  projection?: DayProjection;
  /**
   * The card, and the date the commit filed it under — never the day on screen. `notice` is set
   * only when the log stayed on this phone (no date then: it is filed on the day on screen).
   * `saved` replaces the plain "Logged." confirmation once, when the save needs a word more
   * (`nutrition_unchecked`: "Saved. Nutrition not fully checked.").
   */
  onAdd: (entry: LoggedFood, date?: string, notice?: string, saved?: string) => void;
  /** When the meal was eaten: the day on screen when that is not today (app/page.tsx), else now. */
  at?: Date;
  onSomethingElse: () => void;
  onClose: () => void;
  /** The FAB's capture flow: this sheet closes first, then app/page.tsx sets the mode. */
  onCapture: (method: CaptureMethod) => void;
  /** Present only when NEXT_PUBLIC_FEATURE_SCAN=1 — app/page.tsx decides, as QuickActions does. */
  onScan?: () => void;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(mode === "meal" ? "meal" : "search");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DbFood | null>(null);
  const [portion, setPortion] = useState<DbPortion | null>(null);
  const [qty, setQty] = useState(1);
  const [mealName, setMealName] = useState("");
  const [mealNote, setMealNote] = useState("");
  /** The meal's picks, in the shape the durable commit takes; the list shows their cards. */
  const [mealPicks, setMealPicks] = useState<LogPick[]>([]);
  const items = mealPicks.map((p) => p.card);
  const mealSoFar = mode === "meal" ? sumMacros(items) : null;
  const withMeal = (selected: Macros): Macros => mealSoFar ? ({
    kcal: selected.kcal + mealSoFar.kcal,
    protein: selected.protein + mealSoFar.protein,
    carbs: selected.carbs + mealSoFar.carbs,
    fat: selected.fat + mealSoFar.fat,
  }) : selected;
  /** True while confirmCatalogPortion or saveMeal has a commit in flight — blocks a repeat tap
   *  from minting a second entry_id for the same food or meal (audit: double-submit risk). */
  const [submitting, setSubmitting] = useState(false);
  /** The same guard, read synchronously: two taps in one frame both see `submitting` false. */
  const inFlight = useRef(false);
  /** "Add to meal" taken from this portion view: a second tap in the same frame adds nothing.
   *  Set before the state update, cleared once the view has changed. */
  const addedToMeal = useRef(false);
  useEffect(() => { addedToMeal.current = false; }, [view]);
  /** The commit's shared feedback: pending, the success haptic, and a refusal as the shared alert
   *  on the view the user is still on, with their pick, amount or meal kept (FluidVoice F01-F09). */
  const commitFeedback = useActionFeedback();
  const commitNotice = <ActionFeedbackToast notice={commitFeedback.notice} onDismiss={commitFeedback.dismiss} />;
  /** Sends one commit and throws a refusal's reason, so the shared feedback reads one verdict. */
  const committed = (send: () => ReturnType<typeof commitLogEntry>) => commitFeedback.run(async () => {
    const result = await send();
    const outcome = outcomeFor(result);
    if (!outcome.keep) throw new Error(outcome.message ?? "That did not log. Try again.");
    return result;
  }, { kind: "commit", failureMessage: (cause) => cause instanceof Error ? cause.message : "That did not log. Try again." });

  // ------------------------------------------------------- catalog (Phase 2)
  const useCatalog = catalogSearchEnabled();
  const [revision, setRevision] = useState<CachedRevision | null>(null);
  const [catPortion, setCatPortion] = useState<CachedPortion | null>(null);
  const [grams, setGrams] = useState(100);
  const [typedPer, setTypedPer] = useState<number | null>(null);
  const [gramsText, setGramsText] = useState("100");
  const [blocked, setBlocked] = useState<string | null>(null);
  /** The wire detail behind the portion view, when it came from the network. Null on the cached path. */
  const [detail, setDetail] = useState<FoodDetail | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [foodRefId, setFoodRefId] = useState<string | null>(null);
  /** Why foodRefId is still null — distinguishes "sign in" from a transient RPC/network failure. */
  const [refFailureReason, setRefFailureReason] = useState<FoodRefFailureReason | null>(null);
  /**
   * Two quick taps race on two awaits. Every pick takes a number; after each await the handler
   * bails unless it is still the newest, so a slow first detail can never swap the revision under
   * a newer row, and a food_ref from row B can never be paired with row A's revision.
   */
  const pickSeq = useRef(0);

  const hits = useMemo(() => searchFoods(query, mine), [query, mine]);

  /**
   * `gramsForPortion` throws on a non-positive gramWeight and the portions come from server data,
   * so an unusable portion is dropped before it can reach a pill or the qty stepper.
   */
  function usablePortions(rev: CachedRevision): CachedRevision {
    const portions = rev.portions.filter((p) => Number.isFinite(p.gramWeight) && p.gramWeight > 0);
    return portions.length === rev.portions.length ? rev : { ...rev, portions };
  }

  function startCatalogPortion(rev: CachedRevision) {
    const preferred = rev.portions.find((p) => p.isDefault) ?? rev.portions[0] ?? null;
    setRevision(rev);
    setCatPortion(preferred);
    setTypedPer(null);
    setQty(1);
    const startGrams = preferred ? gramsForPortion({ gramWeight: preferred.gramWeight }, 1) : 100;
    setGrams(startGrams);
    setGramsText(String(startGrams));
    setView("portion");
  }

  /**
   * A cache miss with no network blocks the food and says so — it never logs a zeroed item
   * (phase-2-real-logging.md, Offline). The commit button stays disabled until the food_ref
   * resolves, so a signed-out tap cannot write an entry with no reference.
   */
  async function pickCatalogRow(row: CatalogRow) {
    const seq = ++pickSeq.current;
    setBlocked(null);
    setRevision(null);
    setFoodRefId(null);
    setRefFailureReason(null);
    if (row.offline || row.catalogFoodId === null) {
      // Offline tier: the bundled database has no revision, so the Phase 0 path logs it.
      if (!row.offlineFoodId) {
        setBlocked("That result cannot be opened. Try another.");
        return;
      }
      pick(row.offlineFoodId, row.offlineSource ?? "db");
      return;
    }
    const result = await getFoodDetail(row.catalogFoodId, { revisionId: row.revisionId ?? undefined });
    if (seq !== pickSeq.current) return;
    if (result.kind === "not_found") {
      setBlocked("That food is no longer in the catalog.");
      return;
    }
    if (result.kind === "blocked") {
      setBlocked(
        "No signal, and this food is not saved on the phone yet. Pick another, or log it when you are back online."
      );
      return;
    }
    setDetail(result.kind === "ok" ? result.detail : null);
    const rev = usablePortions(result.kind === "ok" ? toCachedRevision(result.detail) : result.revision);
    startCatalogPortion(rev);
    await attachFoodRef(rev.catalog_food_id, seq);
  }

  /** Favorites-strip tap (lane L): a recipe has no catalog pick to cache, so it only routes to
   *  the recipe screen — quick-logging a serving from the chip is a follow-up ticket. */
  function handleFavoritePick(fav: FavoriteRow) {
    if (fav.kind === "recipe") {
      router.push("/foods#recipes");
      return;
    }
    if (fav.catalogFoodId == null) return;
    void pickCatalogRow({ key: `fav:${fav.id}`, catalogFoodId: fav.catalogFoodId,
      revisionId: fav.revisionId ?? null, description: fav.name, brand: null, sourceTile: "USDA",
      prefStatus: null, qualityFlags: [], offPlan: [], offline: false, score: 1 } as CatalogRow);
  }

  async function attachFoodRef(catalogFoodId: number, seq: number) {
    let ref: string | null = null;
    let reason: FoodRefFailureReason | null = null;
    try {
      ref = await resolveFoodRef(catalogFoodId, (r) => { reason = r; });
    } catch {
      ref = null;
      reason = "rpc_error";
    }
    if (seq !== pickSeq.current) return;
    setFoodRefId(ref);
    setRefFailureReason(reason);
  }

  function setPortionQty(nextQty: number) {
    const q = Math.max(0.25, Math.round(nextQty * 4) / 4);
    setQty(q);
    // Grams typed by hand: the count scales them (150 g at 1 is 300 g at 2), so the stepper never
    // moves alone while the grams and the numbers stay put (UI audit r1).
    if (!catPortion) {
      if (typedPer !== null) { const g = Math.round(typedPer * q); setGrams(g); setGramsText(String(g)); }
      return;
    }
    const g = gramsForPortion({ gramWeight: catPortion.gramWeight }, q);
    setGrams(g);
    setGramsText(String(g));
  }

  function typeGrams(text: string) {
    setGramsText(text);
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) {
      setGrams(n);
      // What one count weighs, from the grams typed: the stepper scales from it without drift.
      setTypedPer(qty > 0 ? n / qty : null);
      setCatPortion(null);
    }
  }

  /**
   * Every pick — catalog, bundled or the account's own — and every meal goes down the one durable
   * commit path (calc audit #15). The outcome is known before `onAdd` runs, so a refused commit
   * (audit #6) never sits in their log as a silent phantom entry; `ok` and `queued` (offline) both
   * add it right away. A pick that cannot be sent (`no_ref`, `unknown_weight`, `invalid_qty`) keeps
   * the local card and says so. Never both for one log: that would count it twice.
   */
  async function logPicks(picks: LogPick[], local: LoggedFood, meal?: { name: string; note: string }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      let prepared: Awaited<ReturnType<typeof preparePickedCommit>>;
      try {
        prepared = await preparePickedCommit({ picks, slot, meal, at });
      } catch (e) {
        // The account changed under the tap: nothing of the old account is shown or written.
        if (!(e instanceof AccountChanged)) {
          commitFeedback.notify({ tone: "error", message: "That did not log. Try again." });
        }
        return;
      }
      if (prepared.status !== "ready") {
        // Marked never sent (`localOnlyCard`), so an Undo owes the server nothing for it.
        onAdd(localOnlyCard(local), undefined, localOnlyMessage(prepared));
        return;
      }
      const { req, entry, account } = prepared;
      // The one date this entry has: what the request files is what the server files, so the card,
      // the commit and the page all use it. Reading the clock again for the card put the meal on
      // today AND on the past day the user had open — two cards for one tap (Grok pass 16, HIGH 2).
      const filed = req.local_date;
      const path = meal ? "meal-log" : "search-log";
      const outcome = await committed(() => commitLogEntry(
        req,
        // T0 §3: the card is on Today before the post, marked pending. `onAdd` below still runs
        // and still replaces it — `upsertExtra` keeps it one card — and a refusal takes it out.
        // Its own run, so two saves in flight together are two taps (Grok pass 6, MEDIUM 5).
        { optimistic: { date: filed, entry }, account, timingPath: path, run: beginRun(path) }
      ));
      if (!outcome.ok) return;
      // The reconciled card, never the object built before the commit: `upsertExtra` replaces by
      // id, so handing on the pre-server copy would overwrite the server's own off-plan flags and
      // grams a moment after they landed.
      // `nutrition_unchecked` adds one line to Today's confirmation; nothing of it is stored.
      if (commitNutritionUnchecked(outcome.value)) {
        onAdd(committedEntry(filed, entry), filed, undefined, NUTRITION_UNCHECKED_COPY);
      } else onAdd(committedEntry(filed, entry), filed);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /** One pick per portion view: two taps before the view changes would count one serving twice. */
  function addToMeal(next: LogPick) {
    if (addedToMeal.current) return;
    addedToMeal.current = true;
    setMealPicks((list) => [...list, next]);
    setQuery("");
    setView("meal");
  }

  async function confirmCatalogPortion() {
    if (!revision || !foodRefId || submitting) return;
    const entryId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    // The same card the scan sheet draws, from the same numbers the portion view is showing.
    const entry = catalogCard({
      revision, entryId, itemId, foodRefId: foodRefId, grams, qty, portion: catPortion, at: new Date(),
      flags: offPlanFlags(`${revision.description} ${revision.brand ?? ""}`),
    });
    const pick: LogPick = { source: "catalog", card: entry, itemId, foodRefId, revision, grams,
      qty: entry.qty, unit: catPortion ? "portion" : "g", portionId: catPortion?.id ?? null };
    if (mode === "meal") {
      addToMeal(pick);
      return;
    }
    await logPicks([pick], entry);
  }

  function pick(id: string, source: "db" | "mine") {
    const f = source === "mine" ? mineAsDb(mine[id]) : dbFood(id);
    if (!f) return;
    setPicked(f);
    // A food with no known unit weight is offered in its own unit only (#383).
    setPortion(logPortionsFor(f)[0]);
    setQty(1);
    setView("portion");
  }

  async function confirmPortion() {
    if (!picked || !portion || submitting) return;
    const entry = sheetCard(picked, portion, qty, { id: newId("f"), at: new Date().toISOString() }, mine);
    const chosen = pickForCard(picked, entry, mine);
    if (mode === "meal") {
      addToMeal(chosen);
      return;
    }
    await logPicks([chosen], entry);
  }

  /**
   * A meal is one server entry carrying every food inside it, whatever its source (audit #3, calc
   * audit #15). Audit #6: a refused commit must not add the meal to their log while pretending it
   * is safe — the user keeps their in-progress meal and sees why.
   */
  async function saveMeal() {
    if (mealPicks.length === 0 || submitting) return;
    setBlocked(null);
    // Only used when the meal cannot be sent: the whole meal, on this phone, with nothing committed
    // (`logPicks` marks it `localOnlyCard`, so an Undo owes the server nothing).
    const local = mealCard({ entryId: crypto.randomUUID(), at: new Date(), items, catalogItems: [],
      name: mealName, note: mealNote });
    await logPicks(mealPicks, local, { name: mealName, note: mealNote });
  }

  /* The same live row in both views. Nothing enabled and no scanner means no row — the sheet
     never shows a button that does nothing. The sheet closes before either flow opens. */
  const captureRow = (
    <CaptureRow
      actions={captureActions()}
      onCapture={closeThenCapture(onClose, onCapture)}
      scan={onScan ? () => { onClose(); onScan(); } : undefined}
    />
  );

  // ------------------------------------------------------------ meal view
  if (view === "meal") {
    const totals = sumMacros(items);
    return (
      <Sheet
        title="Log a meal"
        subtitle="Name it, add what was in it, leave a note. You can come back to the note later."
        onClose={onClose}
        footer={
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between px-1.5">
              <span className={ROW_META_CLASS}>Meal so far</span>
              <span className={`tabular-nums ${ROW_TITLE_CLASS}`}>
                <MacroLine values={totals} />
              </span>
            </div>
            <Button variant="tertiary" block onClick={() => setView("search")}>Add a food to this meal</Button>
            <Button variant="primary" size="lg" block confirmLabel="Logged" {...commitFeedback.controlProps}
              disabled={!canSaveMeal(items.length, submitting)} onClick={saveMeal}>
              Log this meal
            </Button>
            {/* T0 §2: a save that takes more than two seconds says what it is doing. */}
            <WorkingLine active={submitting} step="commit" />
            {commitNotice}
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {captureRow}
          {blocked && <Notice tone="error" title={blocked} className="mb-2" />}
          <label className="flex flex-col gap-1.5">
            <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>Meal name</span>
            <input value={mealName} onChange={(e) => setMealName(e.target.value)} aria-label="Meal name"
              placeholder="Meal name, e.g. Chipotle bowl"
              className="well h-12 w-full px-4 text-body font-medium text-charcoal placeholder:text-muted" />
          </label>
          <div className="flex flex-col gap-2.5">
            <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>
              In this meal
            </span>
            {items.length === 0 ? (
              <Notice tone="neutral" title="Nothing in it yet. Tap “Add a food to this meal”." />
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((i) => (
                  <li key={i.id} className={`flex items-center gap-3 px-3.5 py-3 ${ROW_CLASS}`} style={ROW_STYLE}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={`truncate ${ROW_TITLE_CLASS}`}>
                        {i.name}
                      </span>
                      <span className={`tabular-nums ${ROW_META_CLASS}`}>
                        {fmt(i.qty)} × {i.portionLabel} · <MacroLine values={i.macros} />
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setMealPicks((l) => l.filter((x) => x.card.id !== i.id));
                      }}
                      aria-label={`Remove ${i.name}`}
                      className="tap -mr-2 flex shrink-0 items-center justify-center text-graphite"
                    >
                      <RemoveIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="flex flex-col gap-1.5">
              <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>Note</span>
              <textarea value={mealNote} onChange={(e) => setMealNote(e.target.value)} rows={3} aria-label="Note"
                placeholder="e.g. felt fine after"
                className="well w-full resize-none px-4 py-3 text-caption font-normal text-charcoal placeholder:text-muted" />
            </label>
          </div>
        </div>
      </Sheet>
    );
  }

  // ------------------------------------------------- catalog portion view
  if (view === "portion" && revision) {
    const offPlan = offPlanFlags(`${revision.description} ${revision.brand ?? ""}`);
    if (detail && detailsOpen) {
      return <FoodDetailSheet detail={detail} onClose={() => setDetailsOpen(false)} />;
    }
    return (
      <LogFoodPortion
        revision={revision}
        subtitle={offPlan.length ? offPlanLine(offPlan) : undefined}
        portion={catPortion}
        qty={qty}
        grams={grams}
        gramsText={gramsText}
        mode={mode}
        projection={projection}
        mealSoFar={mealSoFar}
        canCommit={canConfirmPortion(grams, foodRefId, submitting)}
        saving={submitting}
        hint={foodRefId !== null ? null
          : refFailureReason === "rpc_error" ? "Could not save that pick. Try again."
          : "Sign in to log from the catalog."}
        onPortion={(p) => {
          setCatPortion(p);
          setTypedPer(null);
          const g = gramsForPortion({ gramWeight: p.gramWeight }, qty || 1);
          setQty(qty || 1);
          setGrams(g);
          setGramsText(String(g));
        }}
        onQty={setPortionQty}
        onGramsText={typeGrams}
        onDetails={detail ? () => setDetailsOpen(true) : undefined}
        onConfirm={confirmCatalogPortion}
        onBack={() => {
          pickSeq.current += 1;
          setRevision(null);
          setDetail(null);
          setView("search");
        }}
        onClose={onClose}
        notice={commitNotice}
      />
    );
  }

  // --------------------------------------------------------- portion view
  if (view === "portion" && picked && portion) {
    // The grams and macros the commit will store. Grams 0: no known weight, counted in its own unit
    // instead (t17 gap 2) — `massUnknown` says so, never a shown "0 g".
    const shown = (p: DbPortion, q: number) => sheetCard(picked, p, q, { id: "shown", at: "" }, mine);
    const { grams, macros, massUnknown } = shown(portion, qty);
    return (
      <Sheet
        title={picked.name}
        subtitle={picked.flags.length ? offPlanLine(picked.flags) : undefined}
        onClose={onClose}
        footer={
          <div className="flex flex-col gap-2.5">
            <Button variant="primary" size="lg" block disabled={submitting} onClick={confirmPortion}>
              {mode === "meal" ? "Add to meal" : "Add"} · {fmt(qty)} × {portion.label} · <MacroFigure macro="kcal" value={macros.kcal} />
            </Button>
            <WorkingLine active={submitting} step="commit" />
            {commitNotice}
            <Button variant="tertiary" block onClick={() => setView("search")}>Back to search</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2.5">
            <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>
              Serving
            </span>
            <div className="flex flex-wrap gap-2">
              {/* U8: "1 tbsp · 14 g · 126 kcal"; a portion with no known weight states none (#383). */}
              {logPortionsFor(picked).map((p) => (
                <Pill key={p.label} active={p.label === portion.label} onClick={() => setPortion(p)}>
                  {portionPill({ label: p.label, grams: p.grams,
                    kcal: shown(p, 1).macros.kcal })}
                </Pill>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>
              How many
            </span>
            <div className="flex items-center gap-3">
              <div className="pill inline-flex">
                <div className="pill-in flex items-center">
                  <button
                    type="button"
                    onClick={() => setQty((q) => Math.max(0.25, Math.round((q - 0.25) * 4) / 4))}
                    className="tap flex h-11 w-11 items-center justify-center rounded-full text-subheading font-semibold text-graphite"
                    aria-label="Less"
                  >
                    −
                  </button>
                  <span
                    className="min-w-11 text-center text-caption font-normal text-charcoal tabular-nums"
                  >
                    {fmt(qty)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQty((q) => Math.round((q + 0.25) * 4) / 4)}
                    className="tap flex h-11 w-11 items-center justify-center rounded-full text-subheading font-semibold text-graphite"
                    aria-label="More"
                  >
                    +
                  </button>
                </div>
              </div>
              {massUnknown ? (
                <span className={`tabular-nums ${ROW_META_CLASS}`}>
                  = {fmt(qty)} × {portion.label}
                </span>
              ) : grams > 0 && (
                <span className={`tabular-nums ${ROW_META_CLASS}`}>
                  = {fmt(grams)} g
                </span>
              )}
            </div>
          </div>
          <section className={`flex flex-col gap-1 px-3.5 py-3.5 ${ROW_CLASS}`} style={ROW_STYLE}>
            <span className="text-title tabular-nums">
              <span className="kcal">{macros.kcal}</span> <span className="text-caption font-medium text-muted">kcal</span>
            </span>
            <span className="text-caption font-normal text-graphite tabular-nums">
              {fmt(macros.protein)}P · {fmt(macros.carbs)}C · {fmt(macros.fat)}F
            </span>
            <span className={ROW_META_CLASS}>
              {picked.sr === "their list"
                ? "from your list, the numbers you entered"
                : <KcalText text={`per 100 g: ${picked.per100g.kcal} kcal · ${picked.per100g.protein}P ${picked.per100g.carbs}C ${picked.per100g.fat}F · ${picked.sr.startsWith("label") ? picked.sr : "USDA"}`} />}
              {/* The mass is unknown (t17): the numbers are the account's own per-unit count, not a
                  measured weight — a neutral note beside them, never hidden. */}
              {massUnknown && <span className="text-muted" data-partial=""> · {PARTIAL_NOTE}</span>}
            </span>
          </section>
          {projection && <ProjectedDayTotals projection={projection} added={withMeal(macros)} />}
        </div>
      </Sheet>
    );
  }

  // ---------------------------------------------------------- search view
  return (
    <Sheet
      title={mode === "meal" ? "Add a food to the meal" : "Log a food"}
      subtitle="Search ~460 common foods and your own list. Any amount."
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2.5">
          {mode === "meal" && <Button variant="tertiary" block onClick={() => setView("meal")}>Back to the meal</Button>}
          <Button variant="tertiary" block onClick={onSomethingElse}>Not here? Type it from the label…</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {captureRow}
        {blocked && <Notice tone="error" title={blocked} className="mb-2" />}
        {useCatalog ? (
          <>
            <FavoritesStrip onPick={handleFavoritePick} />
            <CatalogSearch mine={mine} autoFocus onPick={pickCatalogRow} />
          </>
        ) : (
          <>
        <label className="flex flex-col gap-1.5">
          <span className={`pl-1.5 ${SECTION_LABEL_CLASS}`}>Search foods</span>
          <SearchField size="lg" value={query} onValueChange={setQuery} label="Search foods"
            placeholder="e.g. chicken, banana, chkn brst" autoFocus />
        </label>
        <div className="flex flex-col gap-2">
          {query.trim() && hits.length === 0 && (
            <p className={`px-1.5 py-2 ${ROW_META_CLASS}`}>
              Nothing matches. Try fewer letters, or type it from the label below.
            </p>
          )}
          {hits.map((h) => (
            <button
              key={`${h.source}:${h.id}`}
              type="button"
              onClick={() => pick(h.id, h.source)}
              className={`tap flex w-full items-center gap-3 px-3.5 py-3 text-left ${ROW_CLASS}`}
              style={ROW_STYLE}
            >
              <span
                className={`flex items-center justify-center ${h.source === "mine" ? BADGE_MINE_CLASS : BADGE_USDA_CLASS}`}
                style={h.source === "mine" ? BADGE_MINE_STYLE : BADGE_USDA_STYLE}
              >
                {h.source === "mine" ? "MINE" : "USDA"}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`truncate ${ROW_TITLE_CLASS}`}>
                  {h.name}
                </span>
                <span className={`tabular-nums ${ROW_META_CLASS}`}>
                  <KcalText text={rowServingLine({ offline: true, offlineSource: h.source, offlineFoodId: h.id }, mine)
                    ?? (h.source === "mine" ? "Your food" : "USDA")} />
                  {h.flags.length > 0 && <span className="text-alert"> · off-plan: {h.flags.join(", ")}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
