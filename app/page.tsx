"use client";

import { AccountChanged, currentAccountOrNull, isAccountClosing, isCurrent, onAccountGone,
  type AccountHandle } from "@/lib/device/account";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { saveExtraNote } from "@/lib/log-note-client";
import { syncFoodPref } from "@/lib/foods/prefs-client";
import { getDay, loadStore, saveStore, upsertExtra, upsertFood } from "@/lib/store";
import {
  saveEatenSlot, saveItemOverride, saveMealEdit, saveSwap,
} from "@/lib/plan-day-client";
import Link from "next/link";
import DayTypeToggle from "@/components/DayTypeToggle";
import { formatMacro } from "@/components/nutrition/spec";
import HeaderAvatar from "@/components/HeaderAvatar";
import { getMealOptions, isMealSlot, SLOT_LABELS } from "@/lib/meals";
import { dayHasPartialNutrition, entryMacros, generatedNotesForDay, planningSlotTarget, resolveDay, scaledSlotTarget } from "@/lib/resolve";
import { SYNCED_EVENT } from "@/lib/sync/client";
import {
  forgetLoggedEntry, LOG_QUEUED_EVENT, logEntryStates, retryUnsavedCommit,
} from "@/lib/log-commit-client";
import { savingElsewhere } from "@/lib/log/today-state";
import { readDeferred, retryDeferred } from "@/lib/log/picked-deferred";
import MealSwapSheet from "@/components/MealSwapSheet";
import type { SwapAlternative } from "@/lib/today/swap-alternatives";
import LogFoodSheet from "@/components/LogFoodSheet";
import { labelAttempts, logLabelFood, settleLabelLog } from "@/components/LogFoodSheet.picks";
import RecipeEatenConfirm from "@/components/RecipeEatenConfirm";
import { useRecipeAccess } from "@/lib/recipe-access-client";
import { LoggedExtraCard } from "@/components/LoggedExtras";
import ShoppingTodayCard from "@/components/today/ShoppingTodayCard";
import NoteSheet from "@/components/NoteSheet";
import AddFoodSheet from "@/components/AddFoodSheet";
import NutrientBreakdown from "@/components/NutrientBreakdown";
import Sheet from "@/components/Sheet";
import type { Food } from "@/lib/foods";
import type { FoodComponent, LoggedFood, SlotId, SlotOverride } from "@/lib/types";
import { AnimatePresence, MotionConfig } from "motion/react";
import TodayDayStrip from "@/components/TodayDayStrip";
import DayCard from "@/components/today/DayCard";
import DuplicateEntryCard from "@/components/today/DuplicateEntryCard";
import { DAY_CARD_EXPLAINER } from "@/components/today/ExplainerPlayer";
import { boardTips, nextMeal } from "@/lib/today/board";
import DayNutrients from "@/components/DayNutrients";
import InstallPrompt from "@/components/InstallPrompt";
import Notice from "@/components/ui/Notice";
import SlotCard, { SlotCardEnter, type SlotVariant } from "@/components/SlotCard";
import { useMealFavorites } from "@/components/today/useMealFavorites";
import SwapSheet from "@/components/SwapSheet";
import EditSlotSheet from "@/components/EditSlotSheet";
import type { TimingRun } from "@/lib/timing";
import BarcodeScanSheet from "@/components/BarcodeScanSheet";
import ScanConfirmSheet from "@/components/ScanConfirmSheet";
import CaptureSheet from "@/components/CaptureSheet";
import type { BarcodeResponse } from "@/lib/barcode/client";
import { captureOverlayProps } from "@/lib/capture-client";
import type { CaptureMethod } from "@/lib/capture/flags";
import { addCups, setCups } from "@/lib/water-client";
import { latestWins } from "@/lib/today/latest-wins";
import { saveExtraTime } from "@/lib/log-time-client";
import { useWaterLine } from "@/lib/today/water-and-weight";
import { useRebalancePanel } from "@/lib/rebalance/panel-client";
import { todayResolveInputs, type TodayLive } from "@/lib/today/resolve-inputs";
import { openSlotCard } from "@/lib/today/open-slot-card";
import { mergeTimeline } from "@/lib/today-timeline";
import { viewedDateFromSearch } from "@/lib/url-date";
import { viewedLogAt } from "@/lib/log/viewed-at";
import { useBodyCapability } from "@/lib/health/capability-client";
import { useTodayBody } from "@/lib/health/today-card";
import ProposalCard from "@/components/ProposalCard";
import { fetchProposals, visibleProposal, type Fresh } from "@/lib/estimator-client";
import { fetchTargetState, settingsWithTargetRevision } from "@/lib/targets/client";
import type { ProposalSummary } from "@/lib/api-types";
import OnboardingInvite from "@/components/Onboarding/OnboardingInvite";
import TodayTour from "@/components/tour/TodayTour";
import ActivityMismatchPrompt from "@/components/ActivityMismatchPrompt";
import { refreshStarterGate, type StarterGate } from "@/lib/foods/today-starter";
import { loadEligibleLocalFoodIds, needsConnection, recheckHeldOpenSet, StampedEligibleSet } from "@/lib/foods/eligible-client";
import { SUGGESTIONS_NEED_CONNECTION } from "@/lib/meals/snapshot";
import { proteinShortfall, slotNote } from "@/lib/today/slot-notes";
import PlanSheet from "@/components/PlanSheet";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import DayCompleteControl from "@/components/today/DayCompleteControl";
import { outcomeFor } from "@/lib/log/outcome";
import { logAgain } from "@/lib/log/log-again";
import { canLogAgain } from "@/lib/log/recent-meals";
import { COUNT_LOG_FAILURE } from "@/lib/today/count-log-once";
import { countLogged as countLoggedOnce } from "@/components/today/count-logged";
import { addedMealTime, clearMeal, nextMealSlot, removeMeal, restoreAddedMeal } from "@/lib/today/meal-actions";
import { loadAcceptedRecipeSelections } from "@/lib/recipes/accepted-client";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";

// ------------------------------------------------------------- date glue
//
// Local-date formatting only — the actual calendar-date logic (day type,
// day type and rotation) all lives in lib/plan.ts and lib/meals.ts. This is
// just "what does today look like as yyyy-mm-dd" and "add N days", done the
// same UTC-midnight-avoiding way plan.ts does it, so a date never silently
// drifts a day in a timezone behind UTC.

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftIsoDate(iso: string, days: number): string {
  const value = parseIsoDate(iso);
  value.setDate(value.getDate() + days);
  return toIsoDate(value);
}

/** "yesterday", or the weekday — the day label for a meal that is still saving. */
function dayLabel(iso: string, today: string): string {
  const day = parseIsoDate(iso);
  const before = new Date(parseIsoDate(today));
  before.setDate(before.getDate() - 1);
  if (toIsoDate(before) === iso) return "yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long" });
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

type MealUndo = { account: AccountHandle; date: string; slot: SlotId;
  before: SlotOverride | undefined; applied: SlotOverride };
/** A note a closed sheet changed: whose entry, the note it replaced, and the note it saved. */
type NoteUndo = { account: AccountHandle; date: string; id: string; before: string; after: string };


// ------------------------------------------------------------------- shell

/**
 * Server and the pre-hydration client render must be byte-identical, so
 * nothing date- or store-dependent renders until after mount. See the
 * `mounted` gate below.
 */
function ShellSkeleton() {
  return (
    <main
      className="mx-auto flex w-full max-w-md flex-col gap-5 px-4"
      style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}
    >
      <div className="h-10 w-40 rounded-full bg-fog" />
      <div className="h-80 rounded-[32px] bg-fog" />
      <div className="flex flex-col gap-3">
        <div className="h-[72px] rounded-[32px] bg-fog" />
        <div className="h-28 rounded-[32px] bg-fog" />
        <div className="h-28 rounded-[32px] bg-fog" />
      </div>
    </main>
  );
}

// -------------------------------------------------------------- the page

export default function Today() {
  const recipeAccess = useRecipeAccess();
  const [mounted, setMounted] = useState(false);
  const [viewedDate, setViewedDate] = useState("");
  // Wall-clock time as a plain epoch-ms number. Read on mount, then kept
  // fresh once a minute and whenever the app comes back to the foreground —
  // an installed PWA is never remounted between breakfast and dinner, so a
  // one-shot read left "Now" pointing at an earlier meal all day.
  const [nowMs, setNowMs] = useState(0);
  const lastSyncIso = useRef("");
  /** Label logs, scoped to the attempt and the sheet that started them (labelAttempts). */
  const [labelLog] = useState(labelAttempts);
  /** Per day, the water set in flight and the newest target waiting behind it (setWater). */
  /** The latest render's `livePlan`, so a count that outlives a render reads today's inputs. */
  const planInputs = useRef<(date: string) => ReturnType<typeof resolveDay>>(() => { throw new Error("not mounted"); });
  const waterSets = useRef(new Map<string, (next: { account: AccountHandle; cups: number }) => Promise<void>>());
  const [, setTick] = useState(0);
  const [swapSlot, setSwapSlot] = useState<SlotId | null>(null);
  const [editSlot, setEditSlot] = useState<SlotId | null>(null);
  const [planSlot, setPlanSlot] = useState<SlotId | null>(null);
  const [planOpening, setPlanOpening] = useState(0);
  const [planMode, setPlanMode] = useState<"plan" | "log">("plan");
  const [logOpen, setLogOpen] = useState<"food" | "meal" | null>(null);
  const [logSlot, setLogSlot] = useState<SlotId | null>(null);
  /** The meal card a label, capture or scan was handed off from; null when opened from anywhere else. */
  const [handoffSlot, setHandoffSlot] = useState<SlotId | null>(null);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [breakdownEntry, setBreakdownEntry] = useState<string | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  // Each opening is a new label sheet: an attempt from an earlier one never closes it.
  useEffect(() => { if (labelOpen) labelLog.opened(); }, [labelOpen, labelLog]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  /** Entries the server has that this phone stopped reading back: their card says so in words. */
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  /** Entries nothing ever confirmed: their card offers a retry, and the tap posts. */
  const [unsavedIds, setUnsavedIds] = useState<Set<string>>(new Set());
  /** The same, with nothing left to send: the card asks for the meal to be logged again. */
  const [lostIds, setLostIds] = useState<Set<string>>(new Set());
  const [scanOpen, setScanOpen] = useState(false);
  const [scanResult, setScanResult] = useState<BarcodeResponse | null>(null);
  /** The timing run the scan opened, carried to the confirm sheet so its commit closes that run. */
  const [scanRun, setScanRun] = useState<TimingRun | null>(null);
  /** A meal still saving on another day — Today says so rather than hiding it. */
  const [elsewhere, setElsewhere] = useState<{ date: string; count: number } | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMethod | null>(null);
  const [pendingProposal, setPendingProposal] = useState<Fresh<ProposalSummary[]> | null>(null);
  const [starterGate, setStarterGate] = useState<StarterGate | null>(null);
  const [eligibleFoodIds, setEligibleFoodIds] = useState<Set<string> | null>(null);
  /** The eligible read failed only for want of a connection and a usable stored snapshot (O2). */
  const [suggestionsOffline, setSuggestionsOffline] = useState(false);
  const [starterRefresh, setStarterRefresh] = useState(0);
  /**
   * `viewedDate`, debounced, so paging through several dates fast (a swipe) fires at most one
   * re-read, not one per date landed on along the way. `viewedDate` starts as `""` (before the
   * URL is read) and that FIRST real value is adopted at once, not debounced — only a date
   * change AFTER that waits out the debounce.
   */
  const [debouncedViewedDate, setDebouncedViewedDate] = useState(viewedDate);
  const previousViewedDate = useRef(viewedDate);
  useEffect(() => {
    const leavingPlaceholder = previousViewedDate.current === "";
    previousViewedDate.current = viewedDate;
    if (leavingPlaceholder) { setDebouncedViewedDate(viewedDate); return; }
    const timer = setTimeout(() => setDebouncedViewedDate(viewedDate), 300);
    return () => clearTimeout(timer);
  }, [viewedDate]);
  /** The latest run's `readEligible`, so the debounced-date effect below can call the current
   *  closure without re-running the starter-gate preamble above it on every date change. */
  const readEligibleRef = useRef<() => Promise<void>>(async () => {});
  const [accepted, setAccepted] = useState<{ date: string; rows: AcceptedRecipeSelection[] } | null>(null);
  const [acceptedError, setAcceptedError] = useState<string | null>(null);
  const [recipeEating, setRecipeEating] = useState<AcceptedRecipeSelection | null>(null);

  useEffect(() => {
    if (!recipeAccess.enabled) return;
    if (!viewedDate) return;
    const account = currentAccountOrNull();
    if (!account) return;
    let live = true;
    const read = () => {
      if (document.visibilityState === "hidden") return;
      void loadAcceptedRecipeSelections(shiftIsoDate(viewedDate, -3),
        shiftIsoDate(viewedDate, 3)).then((rows) => {
        if (!live || currentAccountOrNull()?.epoch !== account.epoch) return;
        setAccepted({ date: viewedDate, rows }); setAcceptedError(null);
      }).catch((cause) => {
        if (live && currentAccountOrNull()?.epoch === account.epoch) {
          setAcceptedError(cause instanceof Error ? cause.message : "Accepted recipes could not load.");
        }
      });
    };
    read();
    window.addEventListener("recipe-plan-accepted", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      live = false; window.removeEventListener("recipe-plan-accepted", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [viewedDate, recipeAccess.enabled]);

  useEffect(() => {
    const account = currentAccountOrNull();
    if (!account) return;
    let live = true;
    let ready = false;
    let latestRead = 0;
    const active = () => live && !isAccountClosing()
      && currentAccountOrNull()?.epoch === account.epoch;
    // One read in flight at a time, and a burst of sync passes waits as ONE follow-up read (P06):
    // every pass fires SYNCED_EVENT, and each read recomputes the server snapshot.
    const readOnce = latestWins<void>(async () => {
      if (!ready || !active()) return;
      const read = ++latestRead;
      try {
        const ids = await loadEligibleLocalFoodIds(account, loadStore().foods);
        if (!active() || read !== latestRead) return;
        setEligibleFoodIds(ids);
        setSuggestionsOffline(false);
        setStarterGate("ready");
        setTick((value) => value + 1);
      } catch (error) {
        if (active() && read === latestRead) {
          // Keep the last good eligible set rather than clearing it on a failed read (W8: the
          // server answers 503 on a transient DB read error for every account, so one blip must
          // not wipe a held set that is still good, and generate from nothing). The Retry notice
          // still shows; only the held ids themselves are left alone.
          setSuggestionsOffline(needsConnection(error));
          setStarterGate("unavailable");
        }
      }
    });
    const readEligible = () => readOnce();
    readEligibleRef.current = readEligible;
    void (async () => {
      const status = await refreshStarterGate();
      if (!active()) return;
      if (status !== "ready") {
        // Same "keep the last good set" as readEligible's own catch above: a failed gate check
        // (e.g. a Retry tap that still finds no connection) must not wipe a set that is still good.
        // The gate's own rule and profile reads need the network; offline, say that rather than
        // blaming the food rules (a fresh offline visit never reaches the snapshot read).
        setSuggestionsOffline(status === "unavailable" && typeof navigator !== "undefined" && navigator.onLine === false);
        setStarterGate(status);
        return;
      }
      ready = true;
      await readEligible();
    })();
    window.addEventListener(SYNCED_EVENT, readEligible);
    return () => {
      live = false;
      window.removeEventListener(SYNCED_EVENT, readEligible);
    };
  }, [starterRefresh]);
  // A later date change (debounced above) re-runs the SAME read through the ref, without
  // re-running the starter-gate preamble the effect above only needs once per `starterRefresh`;
  // `readEligible` itself still guards on `ready`/`active`/the account's current epoch.
  const firstDebouncedRead = useRef(true);
  useEffect(() => {
    if (firstDebouncedRead.current) { firstDebouncedRead.current = false; return; }
    void readEligibleRef.current();
  }, [debouncedViewedDate]);
  /**
   * W137: an open food-world set held across a date change seeds nothing on the new date until the
   * server's token is read again. It is marked provisional in the render that sees the new date
   * (so no committed render plans from it), then rechecked without blocking Today; the debounced
   * read above replaces it either way. A closed account's set is never marked and asks nothing.
   */
  const [freshnessDate, setFreshnessDate] = useState(viewedDate);
  const [openRecheck, setOpenRecheck] = useState<{ set: StampedEligibleSet; n: number } | null>(null);
  const [openVerdicts, setOpenVerdicts] = useState(0);
  if (freshnessDate !== viewedDate) {
    setFreshnessDate(viewedDate);
    if (eligibleFoodIds instanceof StampedEligibleSet && eligibleFoodIds.heldOpen) {
      eligibleFoodIds.markProvisional();
      setOpenRecheck({ set: eligibleFoodIds, n: (openRecheck?.n ?? 0) + 1 });
    }
  }
  useEffect(() => {
    if (!openRecheck) return;
    const account = currentAccountOrNull();
    if (!account) return;
    let live = true;
    void recheckHeldOpenSet(account, openRecheck.set).then((verdict) => {
      if (live && verdict !== "provisional") setOpenVerdicts((value) => value + 1);
    });
    return () => { live = false; };
  }, [openRecheck]);
  /**
   * The one owner of Today's writes (FluidVoice F01-F09): eaten marks, meal clears and deletes, an
   * added meal, a retried log and a log a closed sheet confirmed. Keys light only the control that
   * started a write; every run queues behind the one in flight, so no write joins another.
   */
  const todayFeedback = useActionFeedback();
  // The meal card heart: each plate's saved meal, saved and undone in the page's toast (meal cards v3).
  const mealFavorites = useMealFavorites({ eligible: eligibleFoodIds, feedback: todayFeedback });
  const dismissToday = todayFeedback.dismiss;

  useEffect(() => onAccountGone(() => {
    dismissToday();
    setAccepted(null);
    setAcceptedError(null);
    setRecipeEating(null);
  }), [dismissToday]);

  // The catch-up can redraw a recovered card on the date its request files it under, which after
  // midnight is not the day on screen. A silent write onto a hidden day cannot be seen
  // and will log again (Grok pass 23, MEDIUM 2).
  useEffect(() => {
    if (!viewedDate) return undefined;
    let live = true;
    const read = () => {
      void savingElsewhere(viewedDate).then((found) => { if (live) setElsewhere(found); });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(LOG_QUEUED_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(SYNCED_EVENT, read);
      window.removeEventListener(LOG_QUEUED_EVENT, read);
    };
  }, [viewedDate]);

  useEffect(() => {
    let live = true;
    const read = () => {
      void logEntryStates().then((s) => {
        if (!live) return;
        setPendingIds(s.pending);
        setStaleIds(s.stale);
        setUnsavedIds(s.unsaved);
        setLostIds(s.lost);
      });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(LOG_QUEUED_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(SYNCED_EVENT, read);
      window.removeEventListener(LOG_QUEUED_EVENT, read);
    };
  }, []);

  useEffect(() => {
    const nowDate = new Date();
    lastSyncIso.current = toIsoDate(nowDate);
    setViewedDate(viewedDateFromSearch(window.location.search, lastSyncIso.current));
    setNowMs(nowDate.getTime());
    setMounted(true);

    function syncClock() {
      const fresh = new Date();
      const freshIso = toIsoDate(fresh);
      const previousIso = lastSyncIso.current;
      lastSyncIso.current = freshIso;
      setNowMs(fresh.getTime());
      // Midnight rolled over while the app sat open on "today": follow it,
      // but leave a deliberately chosen other date alone.
      if (previousIso !== freshIso) {
        setViewedDate((viewed) => (viewed === previousIso ? freshIso : viewed));
      }
    }
    const interval = window.setInterval(syncClock, 60_000);
    function onVisible() {
      if (document.visibilityState === "visible") syncClock();
    }
    const onSynced = () => setTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(SYNCED_EVENT, onSynced);
    };
  }, []);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return; // no account bound: nothing of anyone's to fetch
    let live = true;
    void fetchProposals(h).then((result) => {
      if (live) setPendingProposal(result);
    }).catch(() => {}); // an account that has since gone: nothing to show
    return () => {
      live = false;
    };
  }, []);

  const { water, rereadWater } = useWaterLine(viewedDate, mounted);
  // What the page knows now that the stored day does not carry (Phase 19 R2, Sol re-plan). Today's
  // own resolves and the "Rebalance my day" hook all build their resolveDay inputs from this one
  // object through lib/today/resolve-inputs.ts, so the panel always resolves the day Today shows.
  // Memoized (Sol R2 perf fix): an identical `live` lets the calendar strip's own status cache
  // (components/today/use-strip-statuses.ts) skip a recompute on a render none of these changed —
  // a plain object literal here was a fresh reference every render, so that cache never hit.
  const live: TodayLive = useMemo(() => ({ eligibleFoodIds: eligibleFoodIds ?? undefined, accepted,
    recipeAccessEnabled: recipeAccess.enabled, ruleReviewReady: starterGate === "ready" }),
    // `openRecheck`/`openVerdicts` (W137): the held set changed state in place, so derived caches recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligibleFoodIds, accepted, recipeAccess.enabled, starterGate, openRecheck, openVerdicts]);
  // Read-only, gated off by default: hidden pre-mount (useRebalancePanel starts with enabled: false)
  // and on every date but the device's local today (classifyDay's hidden row).
  const rebalancePanel = useRebalancePanel(viewedDate, live);
  // One viewed-date body read, shared by the Health Overview Orbit and the Body card below it.
  const bodyCapability = useBodyCapability();
  const bodyRead = useTodayBody(viewedDate, bodyCapability === "enabled");

  // A day as stored at the moment of the call, with the latest recipe overlay and food rules.
  // A layout effect, not a passive one (audit f2 MINOR): every layout effect in the tree runs
  // before any passive effect does, so a child's plain `useEffect` can no longer run while this
  // ref still holds the pre-mount "not mounted" stub.
  useLayoutEffect(() => {
    planInputs.current = (date) => resolveDay(...todayResolveInputs(loadStore(), date, live).args);
  });

  if (!mounted) {
    return <ShellSkeleton />;
  }

  // Just a re-render bump after a store mutation — no clock read here, so
  // it stays safe to define in the render body (react-hooks/purity flags
  // any impure call reachable from a closure created during render, even
  // one only ever invoked from an event handler).
  const refresh = () => setTick((t) => t + 1);

  // Approving "Use these" only decides the proposal server-side (lib/estimator-client.ts's
  // decideProposalOnline); it never told resolveDay. Pull the now-active profile and mirror it
  // onto Settings so Today actually reflects it — same shape lib/resolve.ts's ratiosFor reads.
  async function onProposalDecided(decision: "approve" | "reject") {
    setPendingProposal(null);
    if (decision !== "approve") return;
    const state = await fetchTargetState();
    if (state.status !== "ready" || !state.target.revision) return;
    const current = loadStore();
    saveStore({
      ...current,
      settings: settingsWithTargetRevision(current.settings, state.target.revision),
    });
    refresh();
  }

  const store = loadStore();
  const now = new Date(nowMs);
  const todayIso = toIsoDate(now);
  const isToday = viewedDate === todayIso;

  // The one builder applies the dated recipe overlay and the live readiness (lib/today/resolve-inputs.ts).
  const { store: planStore, args: resolveArgs } = todayResolveInputs(store, viewedDate, live);
  const resolved = resolveDay(...resolveArgs);
  // One generator run per render serves the protein notice and every card's quiet line (U28–U30).
  const generatedNotes = starterGate === "ready"
    ? generatedNotesForDay(planStore, viewedDate, eligibleFoodIds ?? undefined) : null;
  const proteinShort = proteinShortfall(generatedNotes);
  // A log started here files on the day on screen when that day is past, else on today
  // (lib/log/viewed-at.ts), so its sheet previews the totals and targets of the day it files on.
  const logDay = viewedDate && viewedDate > todayIso
    ? resolveDay(planStore, todayIso, 0, eligibleFoodIds ?? undefined) : resolved;
  const logProjection = { consumed: logDay.consumed, targets: logDay.targets };
  const nowM = isToday ? now.getHours() * 60 + now.getMinutes() : -1;

  // The last slot whose time has arrived. Drives MISSED (below) — unchanged.
  let currentSlotId: SlotId | null = null;
  if (isToday) {
    for (const s of resolved.slots) {
      if (timeToMinutes(s.time) <= nowM) currentSlotId = s.slot;
    }
  }
  /** The slot a capture logs into: the meal card it came from, else the current slot, else the first. */
  const captureSlot: SlotId = handoffSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1";

  // The slot to promote: "what do I eat, right now?" That is the current
  // slot if it is still unticked; otherwise the first unticked slot after
  // it ("Next"). Before the first slot of the day it is simply the first
  // slot. UI-only — it never feeds the MISSED rule.
  let focusSlotId: SlotId | null = null;
  let focusLabel: "Now" | "Next" = "Next";
  if (isToday) {
    const currentIndex = resolved.slots.findIndex((s) => s.slot === currentSlotId);
    const focus = resolved.slots.find((s, i) => i >= currentIndex && !s.eaten);
    if (focus) {
      focusSlotId = focus.slot;
      focusLabel = focus.slot === currentSlotId ? "Now" : "Next";
    }
  }

  async function toggleEaten(slotId: SlotId) {
    const day = getDay(viewedDate);
    const changedAt = now.toISOString();
    const slot = resolved.slots.find((item) => item.slot === slotId);
    const selected = recipeAccess.enabled && accepted?.date === viewedDate && !day?.eaten?.[slotId]
      ? accepted.rows.find((row) => row.localDate === viewedDate && row.slotId === slotId
        && slot?.meal?.id === `recipe:${row.recipeRevisionId}`) : null;
    if (selected) { setRecipeEating(selected); return; }
    const generated = slot?.meal?.id && (slot.meal.id.startsWith("suggested:")
      || slot.meal.id.startsWith("recipe:")) && slot.components.length
      ? { baseMealId: slot.meal.id, title: slot.meal.name, components: slot.components } : undefined;
    const date = viewedDate;
    const account = currentAccountOrNull();
    const wasEaten = Boolean(day?.eaten?.[slotId]);
    const label = slot?.label ?? SLOT_LABELS[slotId];
    const sameAccount = () => currentAccountOrNull()?.epoch === account?.epoch
      && currentAccountOrNull()?.userId === account?.userId;
    await todayFeedback.run(async () => {
      await saveEatenSlot(date, slotId, wasEaten ? null : changedAt, changedAt, generated);
      if (sameAccount()) refresh();
    }, { kind: "commit", queue: true, key: `eaten:${slotId}`, stale: () => !sameAccount(),
      successMessage: wasEaten ? `${label} marked not eaten.` : `${label} marked eaten.`,
      failureMessage: (cause) => cause instanceof Error ? cause.message : "The eaten mark did not save.",
      // Undo is the same tap again, and only while the mark is still the one this write set.
      undo: { action: () => {
        if (!sameAccount()) return;
        if (Boolean(getDay(date)?.eaten?.[slotId]) !== wasEaten) void toggleEaten(slotId);
        else todayFeedback.notify({ tone: "error", message: "This meal changed again. The earlier change cannot be undone." });
      } },
    });
  }

  async function selectSwap(slotId: SlotId, mealId: string | null) {
    await saveSwap(viewedDate, slotId, mealId);
    setSwapSlot(null);
    refresh();
  }

  async function chooseMealAlternative(slotId: SlotId, option: SwapAlternative) {
    const baseMealId = resolved.slots.find((s) => s.slot === slotId)?.meal?.id ?? null;
    await saveMealEdit(viewedDate, slotId, baseMealId,
      { components: option.components, planned: plannedComponents(slotId), title: option.name });
    refresh();
  }

  async function backToSuggestedMeal(slotId: SlotId) {
    const baseMealId = resolved.slots.find((s) => s.slot === slotId)?.meal?.id ?? null;
    await saveMealEdit(viewedDate, slotId, baseMealId,
      { components: null, planned: plannedComponents(slotId), title: null });
    refresh();
  }

  /**
   * When a meal logged from this screen was eaten: now on today, else the slot's own time on the day
   * on screen (UI audit 2026-10-07: a log from a past day's card was filed under today, unseen).
   */
  function logAtFor(slotId: SlotId): Date | undefined {
    return viewedLogAt(viewedDate, todayIso, resolved.slots.find((slot) => slot.slot === slotId)?.time);
  }

  function logFood(entry: LoggedFood, date?: string, notice?: string, saved?: string) {
    // `upsertExtra`, not `addExtra`: the optimistic commit (T0 §3) has usually already put this
    // entry on the day, and a second copy would double the calories. On the date the COMMIT filed
    // it under, which is the day the server has it on: filing it under the day currently being
    // looking at put the same meal on two days at once (Grok pass 16, HIGH 2).
    upsertExtra(date ?? viewedDate, entry);
    setLogOpen(null);
    refresh();
    // A log that stayed on this phone says so, and stays until dismissed (DESIGN.md §Action feedback).
    if (notice) todayFeedback.notify({ tone: "error", message: notice });
    else confirmLogged(saved);
  }

  function unlogFood(id: string) {
    // A delete retires the pending record too, so nothing keeps asking the server about an
    // entry removed from the day.
    void forgetLoggedEntry(viewedDate, id);
    setOpenEntry(null);
    refresh();
  }

  /** "Log again" on an entry (W123): a new entry now, on today, through the commit path. */
  async function logEntryAgain(entry: LoggedFood) {
    setOpenEntry(null);
    try {
      const done = await logAgain(entry);
      // A fresh entry id is never another tab's: `owned_elsewhere` here is an account switch.
      if (!done || done.result.status === "owned_elsewhere") return;
      const outcome = outcomeFor(done.result);
      if (!outcome.keep) {
        todayFeedback.notify({ tone: "error", message: outcome.message ?? "That did not log. Try again." });
        return;
      }
      // The commit already put the card on that day and settled it; nothing to add here.
      refresh();
      // Kept either way: a mark or a "still saving" line is news, not a failure.
      if (outcome.message) todayFeedback.notify({ tone: "changed", message: outcome.message });
      else confirmLogged(done.date === todayIso ? "Logged again for today." : "Logged again.");
    } catch (e) {
      if (!(e instanceof AccountChanged)) {
        todayFeedback.notify({ tone: "error", message: "That did not log. Try again." });
      }
    }
  }

  const noteOf = (date: string, id: string) => getDay(date)?.extras?.find((extra) => extra.id === id)?.note ?? "";

  async function noteEntry(id: string, note: string) {
    await saveExtraNote(viewedDate, id, note);
    refresh();
  }

  /** The sheet closed on a saved, changed note: Today confirms it with Undo to the earlier note. */
  function noteSaved(id: string, before: string, after: string) {
    const account = currentAccountOrNull();
    if (!account) return;
    const session: NoteUndo = { account, date: viewedDate, id, before, after };
    todayFeedback.notify({ tone: "success", message: "Note saved.",
      action: { label: "Undo", action: () => void undoNote(session) } });
  }

  /** Undo writes the earlier note back through the same path, for the same account, if untouched since. */
  async function undoNote(session: NoteUndo) {
    const current = currentAccountOrNull();
    if (current?.epoch !== session.account.epoch || current?.userId !== session.account.userId) return;
    if (noteOf(session.date, session.id) !== session.after) {
      todayFeedback.notify({ tone: "error", message: "This note changed again. The earlier note cannot be restored." });
      return;
    }
    await todayFeedback.run(async () => {
      await saveExtraNote(session.date, session.id, session.before);
      if (currentAccountOrNull()?.epoch === session.account.epoch) refresh();
    }, { kind: "change", queue: true, key: `note:${session.id}`,
      stale: () => currentAccountOrNull()?.epoch !== session.account.epoch,
      successMessage: "Note restored.", failureMessage: "Undo did not save. Try again." });
  }

  /**
   * Record what was actually eaten in one slot, or `null` to drop back to the plan. The slot
   * re-sums from what is on it; nothing else on the day is resized.
   */
  function plannedComponents(slot: SlotId) {
    const day = store.days[viewedDate] ?? { date: viewedDate };
    const itemOverrides = { ...day.itemOverrides };
    delete itemOverrides[slot];
    return resolveDay({ ...store, days: { ...store.days, [viewedDate]: { ...day, itemOverrides } } }, viewedDate,
      0, eligibleFoodIds ?? undefined)
      .slots.find((s) => s.slot === slot)?.components ?? [];
  }

  async function saveSlotEdit(slot: SlotId, components: FoodComponent[] | null, note?: string, time?: string) {
    const baseMealId = resolved.slots.find((s) => s.slot === slot)?.meal?.id ?? null;
    const current = resolved.slots.find((s) => s.slot === slot)?.components ?? [];
    const changed = components === null || JSON.stringify(components) !== JSON.stringify(current);
    await saveMealEdit(viewedDate, slot, baseMealId, { components: changed ? components : undefined, planned: plannedComponents(slot), note, time });
    refresh();
  }

  async function saveSlotTime(slot: SlotId, time: string) {
    const baseMealId = resolved.slots.find((s) => s.slot === slot)?.meal?.id ?? null;
    await saveMealEdit(viewedDate, slot, baseMealId, { time, planned: plannedComponents(slot) });
    refresh();
  }

  async function changeMeal(slot: SlotId, kind: "clear" | "delete") {
    const account = currentAccountOrNull();
    if (!account) return;
    const date = viewedDate;
    const day = getDay(date);
    const visible = resolved.slots.find((item) => item.slot === slot);
    if (day?.eaten?.[slot] || visible?.eaten) {
      todayFeedback.notify({ tone: "error", message: "Mark this meal not eaten before clearing or deleting it." });
      return;
    }
    const before = day?.itemOverrides?.[slot];
    const mealId = visible?.meal?.id ?? null;
    const applied = kind === "clear" ? clearMeal(before, mealId) : removeMeal(before, mealId);
    const pending: MealUndo = { account, date, slot, before, applied };
    await todayFeedback.run(async () => {
      const saved = await saveItemOverride(date, slot, applied);
      pending.applied = saved.itemOverrides?.[slot] ?? applied;
      if (currentAccountOrNull()?.epoch === account.epoch) refresh();
    }, { kind: "change", queue: true, key: `meal:${slot}`, stale: () => currentAccountOrNull()?.epoch !== account.epoch,
      successMessage: kind === "clear" ? `${SLOT_LABELS[slot]} cleared` : `${SLOT_LABELS[slot]} deleted`,
      failureMessage: "That change did not save. Try again.",
      undo: { action: () => void undoMeal(pending) } });
  }

  async function undoMeal(pending: MealUndo) {
    const currentAccount = currentAccountOrNull();
    if (currentAccount?.epoch !== pending.account.epoch
      || currentAccount?.userId !== pending.account.userId) return;
    if (JSON.stringify(getDay(pending.date)?.itemOverrides?.[pending.slot])
      !== JSON.stringify(pending.applied)) {
      todayFeedback.notify({ tone: "error", message: "This meal changed again. The earlier change cannot be undone." });
      return;
    }
    await todayFeedback.run(async () => {
      await saveItemOverride(pending.date, pending.slot, pending.before ?? null);
      if (currentAccountOrNull()?.epoch === pending.account.epoch) refresh();
    }, { kind: "change", queue: true, key: `meal:${pending.slot}`,
      stale: () => currentAccountOrNull()?.epoch !== pending.account.epoch,
      failureMessage: "Undo did not save. Try again." });
  }

  async function addMeal() {
    const account = currentAccountOrNull();
    if (!account) return;
    const slot = nextMealSlot(store, viewedDate, resolved.dayType);
    if (!slot) return;
    const previous = getDay(viewedDate)?.itemOverrides?.[slot];
    const override = restoreAddedMeal(previous, addedMealTime(resolved.slots));
    const date = viewedDate;
    await todayFeedback.run(async () => {
      await saveItemOverride(date, slot, override);
      if (currentAccountOrNull()?.epoch === account.epoch) refresh();
    }, { kind: "change", queue: true, key: "meal:add", failureMessage: "Meal could not be added. Try again.",
      stale: () => currentAccountOrNull()?.epoch !== account.epoch });
  }

  /** A log a sheet committed, and felt, before it closed: Today says so without a second haptic. */
  /** `saved`: the one save that needs a word more ("Saved. Nutrition not fully checked."). */
  function confirmLogged(saved?: string) {
    todayFeedback.notify({ tone: "success", message: saved ?? "Logged." });
  }

  /**
   * The Plan panel logged a plate, a menu pick or "I had …" under this slot (lib/plan/photo-log.ts).
   * On the day it was FILED — which need not be the day on screen — the slot then reads eaten: its
   * plan is replaced by an empty "counted in your log" meal, so the log entry is the one record and
   * nothing is counted twice (lib/today/count-log-once.ts, audit b4b #2).
   */
  async function slotLogged(slotId: SlotId, filed: string) {
    const account = currentAccountOrNull();
    refresh();
    // The panel's own button already said "Logged" (components/plan/PanelReview.tsx): no toast too.
    if (account) await countLogged(account, slotId, filed);
  }

  /** The filed day read from the store as it is now (components/today/count-logged.ts, audit r4). */
  function countLogged(account: AccountHandle, slotId: SlotId, filed: string) {
    return countLoggedOnce(account, slotId, filed, {
      dayOf: getDay, planFor: (date) => planInputs.current(date),
      saveOverride: saveItemOverride, saveEaten: (date, slot, at) => saveEatenSlot(date, slot, at, at),
      onChanged: refresh,
      onFailed: (retry) => todayFeedback.notify({ tone: "error", message: COUNT_LOG_FAILURE,
        action: { label: "Try again", action: retry } }),
    }) ?? undefined;
  }

  /** The unsaved card's own retry, through the same shared feedback as every other Today write. */
  async function retryLogged(id: string) {
    const account = currentAccountOrNull();
    // A refused deferred picked log (t17 gap 1) is a different write from the plain unsaved/lost
    // retry below: it re-pins a stale catalog pick before sending, rather than resending as is.
    const deferred = account ? await readDeferred(account, id) : undefined;
    if (account && deferred?.refused) {
      await todayFeedback.run(async () => {
        const result = await retryDeferred(account, id);
        refresh();
        if (result.status === "gone" || result.status === "offline") throw new Error(result.reason);
      }, { kind: "commit", queue: true, key: `retry:${id}`,
        stale: () => currentAccountOrNull()?.epoch !== account?.epoch,
        failureMessage: (cause) => cause instanceof Error ? cause.message : "That did not save. Try again." });
      return;
    }
    // Nothing was sent (a live commit owns the entry, or nothing is left to save): settle quietly.
    let nothingSent = false;
    await todayFeedback.run(async () => {
      const result = await retryUnsavedCommit(id);
      nothingSent = result === null;
      refresh();
      const outcome = result ? outcomeFor(result) : null;
      if (outcome && !outcome.keep) throw new Error(outcome.message ?? "That did not save. Try again.");
    }, { kind: "commit", queue: true, key: `retry:${id}`,
      stale: () => nothingSent || currentAccountOrNull()?.epoch !== account?.epoch,
      failureMessage: (cause) => cause instanceof Error ? cause.message : "That did not save. Try again." });
  }

  function selectDate(date: string) {
    setRecipeEating(null);
    setViewedDate(date);
    const url = new URL(window.location.href);
    url.searchParams.set("d", date);
    window.history.replaceState(window.history.state, "", url);
  }

  // "Type it from the label": save it to the account list (so it is searchable next
  // time) and log one serving of it right now.
  function logFromLabel(food: Food): Promise<string | void> {
    // One attempt at a time: a second tap, or a new sheet opened while this one is still saving,
    // is told "Still saving the last one." rather than reading as logged.
    return labelLog.submit((isCurrentSheet) => logLabelServing(food, isCurrentSheet));
  }

  /** Answers a refusal's message: the label sheet then stays open with the typed draft. */
  async function logLabelServing(food: Food, isCurrentSheet: () => boolean): Promise<string | void> {
    upsertFood(food);
    // The third food mutation site (the other two are on Foods > My foods): a label typed
    // from the FAB is a new food, so its pref goes to the server now rather than waiting for the
    // next backfill run.
    void syncFoodPref(food);
    // One serving of the new food, through the durable commit path (calc audit #15); a food that
    // cannot be sent keeps its local card and says so. Never both. The sheet closes only once the
    // serving is committed or kept here; a refusal leaves it open with the draft.
    const slotId = handoffSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1";
    const logged = await logLabelFood(food, slotId, logAtFor(slotId));
    // Only the sheet this attempt came from: a newer one the user opened meanwhile stays open.
    return settleLabelLog(logged, { viewedDate, close: () => { if (isCurrentSheet()) setLabelOpen(false); }, refresh,
      confirmLogged, notify: todayFeedback.notify });
  }

  async function logWater() {
    await addCups(viewedDate, 1);
    await rereadWater();
    refresh();
  }

  /** The water dial's slider and the board tile's scrub set the day's count directly, up or down
   *  (T8's correction rule). An absolute set, one write at a time per day, the newest target
   *  winning: never a delta from a count this render read (audit b4b #4). */
  async function setWater(cups: number) {
    const account = currentAccountOrNull();
    if (!account) return;
    const date = viewedDate;
    let set = waterSets.current.get(date);
    if (!set) {
      set = latestWins(async (next: { account: AccountHandle; cups: number }) => {
        if (isCurrent(next.account)) await setCups(date, next.cups, next.account);
      });
      waterSets.current.set(date, set);
    }
    await set({ account, cups });
    if (!isCurrent(account)) return;
    await rereadWater();
    refresh();
  }

  const proposal = visibleProposal(pendingProposal);
  const activeSlot = swapSlot ? resolved.slots.find((s) => s.slot === swapSlot) : undefined;
  const swapOverride = swapSlot ? getDay(viewedDate)?.itemOverrides?.[swapSlot] : undefined;
  const swapBaseStore = swapSlot && swapOverride ? {
    ...store, days: { ...store.days, [viewedDate]: {
      ...(store.days[viewedDate] ?? { date: viewedDate }),
      itemOverrides: Object.fromEntries(Object.entries(store.days[viewedDate]?.itemOverrides ?? {})
        .filter(([id]) => id !== swapSlot)),
    } },
  } : store;
  const swapTarget = swapSlot ? scaledSlotTarget(swapBaseStore, viewedDate, resolved.dayType, swapSlot)
    : undefined;
  const plannedSlot = planSlot ? resolved.slots.find((s) => s.slot === planSlot) : undefined;

  /** One card panel at a time: opening a flow on any meal card closes the others. */
  function openCardPanel(open: () => void) {
    setPlanSlot(null); setSwapSlot(null); setEditSlot(null); setLogSlot(null); setLogOpen(null);
    open();
  }

  /** The flow a meal card started, rendered attached to that card instead of as a bottom sheet. */
  function cardAttachment(id: SlotId): ReactNode {
    if (plannedSlot && plannedSlot.slot === id) return <PlanSheet key={`plan-${planOpening}-${viewedDate}-${plannedSlot.slot}`}
      date={viewedDate} slot={plannedSlot} mode={planMode}
      onLogged={(filed) => void slotLogged(plannedSlot.slot, filed)}
      target={planningSlotTarget(store, viewedDate, resolved.dayType, plannedSlot.slot)}
      onClose={() => setPlanSlot(null)} onPlaced={refresh} />;
    if (swapSlot === id && activeSlot?.meal && isMealSlot(swapSlot)) return <MealSwapSheet key={`swap-${viewedDate}-${swapSlot}-${activeSlot.time}`}
      slot={activeSlot} date={viewedDate} target={swapTarget} foods={store.foods}
      currentOverride={!!swapOverride && (!swapOverride.followPlan || !!swapOverride.title)}
      onSelect={(option) => chooseMealAlternative(swapSlot, option)}
      onReset={() => backToSuggestedMeal(swapSlot)}
      onEdit={() => { setEditSlot(swapSlot); setSwapSlot(null); }}
      onClose={() => setSwapSlot(null)} />;
    if (swapSlot === id && activeSlot?.meal) return <SwapSheet key={swapSlot} slot={swapSlot}
      options={getMealOptions(resolved.dayType, swapSlot)}
      currentMealId={activeSlot.meal.id}
      isDefaultPick={!getDay(viewedDate)?.swaps?.[swapSlot]}
      onSelect={(mealId) => void selectSwap(swapSlot, mealId)}
      onUseRotation={() => void selectSwap(swapSlot, null)}
      onClose={() => setSwapSlot(null)} />;
    if (editSlot === id) {
      const edited = resolved.slots.find((slot) => slot.slot === editSlot);
      return <EditSlotSheet key={`edit-${editSlot}-${viewedDate}`} open
        label={SLOT_LABELS[editSlot]}
        planned={edited?.components ?? []}
        override={getDay(viewedDate)?.itemOverrides?.[editSlot]}
        target={scaledSlotTarget(store, viewedDate, resolved.dayType, editSlot)}
        projection={{ consumed: resolved.consumed, targets: resolved.targets }}
        replaced={edited?.eaten ? edited.macros : undefined}
        ruleMarks={edited?.componentRuleMarks}
        foods={store.foods}
        note={getDay(viewedDate)?.notes?.[editSlot]}
        time={edited?.time}
        onSwap={(isMealSlot(editSlot) || getMealOptions(resolved.dayType, editSlot).length > 1)
          ? () => { setSwapSlot(editSlot); setEditSlot(null); } : undefined}
        onSave={(components, note, time) => saveSlotEdit(editSlot, components, note, time)}
        onClose={() => setEditSlot(null)} />;
    }
    if (logOpen && logSlot === id) return <LogFoodSheet key={`log-${logOpen}-${id}`} mode={logOpen}
      mine={store.foods} slot={id} projection={logProjection} onAdd={logFood} at={logAtFor(id)}
      onSomethingElse={() => { setHandoffSlot(id); setLogOpen(null); setLogSlot(null); setLabelOpen(true); }}
      onClose={() => { setLogOpen(null); setLogSlot(null); }}
      {...captureOverlayProps((mode) => { setHandoffSlot(id); setCaptureMode(mode); },
        () => { setHandoffSlot(id); setScanOpen(true); })} />;
    return null;
  }

  // The plan and what was logged on top of it, as one clock-ordered stack.
  const timeline = mergeTimeline(resolved.slots, resolved.extras);

  const title = isToday
    ? "Today"
    : parseIsoDate(viewedDate).toLocaleDateString(undefined, { weekday: "long" });

  return (
    <MotionConfig reducedMotion="user">
      <main
        className="mx-auto flex w-full max-w-md flex-col gap-5 px-4"
        style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}
      >
        <header className="flex min-h-11 items-center justify-end gap-2 px-1">
          <h1 className="sr-only">{title}</h1>
          <DayTypeToggle
            key={viewedDate}
            date={viewedDate}
            quickMeals={resolved.isFloorDay}
            dayType={resolved.dayType}
            override={getDay(viewedDate)?.dayTypeOverride}
            onSaved={refresh}
          />
          <Link href="/week" aria-label="Open the Week screen"
            className="tap flex h-11 items-center rounded-full px-3 text-caption font-medium text-graphite">
            Week
          </Link>
          <HeaderAvatar />
        </header>

        {/* The strip's `store` is the raw store, not planStore: the strip now projects each day
            itself through resolveStripDay (lib/today/resolve-strip-day.ts), so planStore would
            project the viewed day's overlay and readiness twice. */}
        <DayCard date={viewedDate} today={todayIso} targets={resolved.targets} consumed={resolved.consumed}
          partial={dayHasPartialNutrition(resolved)}
          dayType={resolved.dayType} water={water}
          onAddCup={() => void logWater()} onSetCups={(cups) => void setWater(cups)}
          rebalance={rebalancePanel} onOpenSlot={openSlotCard}
          body={{ ...bodyRead, capability: bodyCapability }}
          calendar={<TodayDayStrip date={viewedDate} today={todayIso} store={store} onSelect={selectDate} live={live} />}
          board={{
            next: nextMeal(resolved.slots, isToday ? nowM : null),
            planned: resolved.slots.filter((slot) => slot.meal !== null).length,
            onMarkEaten: (slot) => void toggleEaten(slot),
            store: planStore,
            eligibleIds: eligibleFoodIds ?? undefined,
            onSelectDate: selectDate,
            onSetWater: (cups) => void setWater(cups),
            tips: boardTips(),
            explainers: [DAY_CARD_EXPLAINER],
          }} />

        <DuplicateEntryCard date={viewedDate} extras={resolved.extras} />

        <DayNutrients day={resolved} accountId={currentAccountOrNull()?.userId ?? null} />

        <OnboardingInvite localState={{
          firstOpenedAt: store.firstOpenedAt,
          onboardedAt: store.settings.onboardedAt,
        }} now={now} />

        {/* The app overview: once after onboarding, and whenever the companion is tapped. */}
        <TodayTour onboardedAt={store.settings.onboardedAt} />

        {elsewhere && (
          <div className="shell">
            <button
              type="button"
              onClick={() => selectDate(elsewhere.date)}
              className="tap w-full text-left"
            >
              <p className="surface px-5 py-4 text-tiny font-normal leading-body-sm text-graphite">
                <span className=" font-normal text-charcoal">
                  {elsewhere.count} meal{elsewhere.count === 1 ? "" : "s"} from{" "}
                  {dayLabel(elsewhere.date, todayIso)}
                </span>{" "}
                still saving. Tap to see {elsewhere.count === 1 ? "it" : "them"}.
              </p>
            </button>
          </div>
        )}

        {resolved.isFloorDay && (
          <div className="shell" role="status">
            <p className="surface px-5 py-4 text-tiny font-normal leading-body-sm text-graphite">
              <span className=" font-normal text-charcoal">Quick meals on.</span> Suggested meals use
              foods ready in about 15 minutes when they still fit your targets. Change this in Day type.
            </p>
          </div>
        )}

        {proposal && (
          <ProposalCard
            proposal={proposal}
            offline={pendingProposal?.stale ?? false}
            asOf={pendingProposal?.stale ? pendingProposal.asOf : undefined}
            onDecided={onProposalDecided}
          />
        )}

        {/* No header row: the stack is no longer only the plan — logged entries sit in it too —
            and the page is already titled with the day. A counter that read "Nothing logged yet"
            directly above a just-logged food was the last thing left saying otherwise. */}
        <section className="flex flex-col gap-3 pb-8" aria-label="Today's plan">
          <h2 className="section-title m-0 px-1 text-heading-sm leading-heading-sm">Your suggested meal plan</h2>
          {recipeAccess.enabled && acceptedError && <Notice tone="error" title={acceptedError}
            action={{ label: "Retry", onClick: () => window.dispatchEvent(new Event("recipe-plan-accepted")) }} />}
          {starterGate === null && <p role="status" className="surface m-0 px-4 py-3 text-caption text-graphite">
            Checking your foods and food rules…
          </p>}
          {/* A one-time check, not onboarding: an account whose food rules came over from the old
              backfill keeps generated suggestions off until the person confirms each rule. Once
              reviewed it never shows again. Yellow is the "needs a look" note (DESIGN.md). */}
          {starterGate === "review" && <a href="/foods#avoids" data-tone="attention"
            className="notice-attention tap flex min-h-11 items-center gap-3 px-4 py-3 text-caption">
            <span className="notice-attention-mark" aria-hidden="true">!</span>
            <span className="flex-1">Review your food rules in Foods › Avoids to see meal suggestions.</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </a>}
          {starterGate === "unavailable" && (suggestionsOffline
            ? <Notice tone="info" title={SUGGESTIONS_NEED_CONNECTION}
              action={{ label: "Try again", onClick: () => setStarterRefresh((value) => value + 1) }} />
            : <Notice tone="attention"
            title="We couldn’t verify your food rules. Try again when you’re online."
            action={{ label: "Retry", onClick: () => setStarterRefresh((value) => value + 1) }} />)}
          {!recipeAccess.enabled && proteinShort && <Notice tone="attention" title={<>
            {proteinShort.available} eligible {proteinShort.available === 1 ? "protein" : "proteins"} for {proteinShort.required} {proteinShort.required === 1 ? "meal" : "meals"}.
            {" "}Star a protein you like in <a href="/foods#eats" className="underline underline-offset-2">Foods › Favorites</a>.
          </>} />}
          {!recipeAccess.enabled && starterGate === "ready" && eligibleFoodIds?.size === 0
            && !proteinShort
            && <Notice tone="attention"
              title="No meal suggestions yet: none of your Favorites could be checked against your food rules. Check Foods › Avoids, or star a few Favorites." />}
          {timeline.map((item, index) => {
            if (item.kind === "extra") {
              return (
                <SlotCardEnter key={item.key} index={index}>
                  <LoggedExtraCard
                    entry={item.entry}
                    pending={pendingIds.has(item.entry.id)}
                    stale={staleIds.has(item.entry.id)}
                    unsaved={unsavedIds.has(item.entry.id)}
                    lost={lostIds.has(item.entry.id)}
                    onRetry={(id) => { void retryLogged(id); }}
                    retryState={todayFeedback.phaseFor(`retry:${item.entry.id}`)}
                    onOpen={setOpenEntry}
                    onDetails={setBreakdownEntry}
                    onTimeChange={(time) => saveExtraTime(viewedDate, item.entry.id, time).then(refresh)}
                  />
                </SlotCardEnter>
              );
            }
            const slot = item.slot;
            // Quick meals no longer replaces the plan (A061), so it never locks Swap.
            const canSwap = isMealSlot(slot.slot) || getMealOptions(resolved.dayType, slot.slot).length > 1;
            const note = slotNote(slot, planStore.days[viewedDate], generatedNotes);
            const variant: SlotVariant =
              slot.slot === focusSlotId
                ? "focus"
                : "standard";

            return (
              <SlotCardEnter key={item.key} index={index}>
                {/* Keyed by date: a draft or preview never carries onto another day (A069). */}
                <SlotCard key={`${viewedDate}:${item.key}`}
                  slot={slot}
                  variant={variant}
                  focusLabel={variant === "focus" ? focusLabel : undefined}
                  canSwap={canSwap}
                  onToggleEaten={() => void toggleEaten(slot.slot)}
                  onOpenSwap={() => openCardPanel(() => setSwapSlot(slot.slot))}
                  onTimeChange={(time) => saveSlotTime(slot.slot, time)}
                  foods={store.foods}
                  onSaveComponents={(components) => saveSlotEdit(slot.slot, components)}
                  onClear={() => void changeMeal(slot.slot, "clear")}
                  onDelete={() => void changeMeal(slot.slot, "delete")}
                  onPlanWithCoach={() => openCardPanel(() => { setPlanOpening((id) => id + 1); setPlanMode("plan"); setPlanSlot(slot.slot); })}
                  onAteSomethingElse={() => openCardPanel(() => { setPlanOpening((id) => id + 1); setPlanMode("log"); setPlanSlot(slot.slot); })}
                  onLogWhatYouAte={() => openCardPanel(() => { setLogSlot(slot.slot); setLogOpen("food"); })}
                  attachment={cardAttachment(slot.slot)}
                  dayTotals={{ consumed: resolved.consumed, targets: resolved.targets }}
                  eatenFeedback={todayFeedback.phaseFor(`eaten:${slot.slot}`)}
                  mealFeedback={todayFeedback.phaseFor(`meal:${slot.slot}`)}
                  emptyReason={note.emptyReason}
                  planMiss={note.planMiss}
                  favorite={mealFavorites.favoriteFor(slot, viewedDate)}
                />
              </SlotCardEnter>
            );
          })}
        </section>

        {/* Owner feedback, 2026-10-08: never a fixed overlay over a meal card's own actions — an
            inline card in the Today flow instead, and only after a meaningful moment (a logged
            meal, else the second app open), never during onboarding or sign-in (neither route
            mounts this page). After the plan, so its late arrival never moves a meal card. */}
        {isToday && <InstallPrompt store={store} />}

        {nextMealSlot(store, viewedDate, resolved.dayType) && (
          <button type="button" onClick={() => void addMeal()} {...todayFeedback.controlPropsFor("meal:add")}
            className={`tap shell flex min-h-11 w-full items-center justify-center text-body-md font-medium text-charcoal ${
              todayFeedback.controlPropsFor("meal:add").className}`}>
            + Add a meal
          </button>
        )}
        <DayCompleteControl date={viewedDate} today={todayIso} />
        <ActionFeedbackToast notice={todayFeedback.notice} onDismiss={todayFeedback.dismiss} />

        {isToday && <ShoppingTodayCard enabled={recipeAccess.enabled} today={todayIso} />}

        <ActivityMismatchPrompt />

        <AnimatePresence>
        </AnimatePresence>

        <AnimatePresence>
          {recipeEating && <RecipeEatenConfirm key={`${recipeEating.localDate}:${recipeEating.slotId}`}
            selection={recipeEating} date={recipeEating.localDate} slotId={recipeEating.slotId as SlotId}
            ruleMark={resolved.date === recipeEating.localDate
              ? resolved.slots.find((slot) => slot.slot === recipeEating.slotId)?.ruleMark : null}
            currentSelection={accepted?.date === recipeEating.localDate
              ? accepted.rows.find((row) => row.localDate === recipeEating.localDate
                && row.slotId === recipeEating.slotId) ?? null : null}
            onClose={() => setRecipeEating(null)} onLogged={() => { setRecipeEating(null); refresh(); }} />}
          {logOpen && !logSlot && (
            <LogFoodSheet
              key={`log-${logOpen}`}
              mode={logOpen}
              mine={store.foods}
              slot={logSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1"}
              projection={logProjection}
              onAdd={logFood}
              at={logAtFor(logSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1")}
              onSomethingElse={() => { setHandoffSlot(null); setLogOpen(null); setLabelOpen(true); }}
              onClose={() => { setLogOpen(null); setLogSlot(null); }}
              {...captureOverlayProps((mode) => { setHandoffSlot(null); setCaptureMode(mode); },
                () => { setHandoffSlot(null); setScanOpen(true); })}
            />
          )}
          {scanOpen && (
            <BarcodeScanSheet
              key="scan"
              onResolved={(r, run) => { setScanOpen(false); setScanResult(r); setScanRun(run ?? null); }}
              onClose={() => setScanOpen(false)}
            />
          )}
          {scanResult && (
            <ScanConfirmSheet
              key="scan-confirm"
              response={scanResult}
              run={scanRun ?? undefined}
              slot={handoffSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1"}
              eatenAt={logAtFor(handoffSlot ?? currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1")}
              projection={logProjection}
              onLogged={(_entryId, saved) => { setScanResult(null); setScanRun(null); refresh(); confirmLogged(saved); }}
              onClose={() => { setScanResult(null); setScanRun(null); }}
            />
          )}
          {captureMode && (
            <CaptureSheet
              key={`capture-${captureMode}`}
              open
              initialMode={captureMode}
              projection={logProjection}
              // On a past day the slot and its time come from one choice, so they never disagree.
              slot={handoffSlot ?? (logAtFor(captureSlot) ? captureSlot : undefined)}
              at={logAtFor(captureSlot)}
              onOpenSearch={() => { setCaptureMode(null); setLogOpen("food"); }}
              onLogged={() => { setCaptureMode(null); refresh(); confirmLogged(); }}
              onClose={() => setCaptureMode(null)}
            />
          )}
          {openEntry && (() => {
            const e = resolved.extras.find((x) => x.id === openEntry);
            return e ? (
              <NoteSheet
                key={`entry-${openEntry}`}
                title={e.name}
                subtitle={e.items ? `Logged meal · ${e.items.length} items` : `Logged · ${fmtQty(e.qty)} × ${e.portionLabel}`}
                note={e.note ?? ""}
                entry={e}
                onSave={(n) => noteEntry(openEntry, n)}
                onSaved={(before, after) => noteSaved(openEntry, before, after)}
                onRemove={() => unlogFood(openEntry)}
                onLogAgain={canLogAgain(e) ? () => { void logEntryAgain(e); } : undefined}
                onClose={() => setOpenEntry(null)}
              />
            ) : null;
          })()}
          {breakdownEntry && (() => {
            const e = resolved.extras.find((x) => x.id === breakdownEntry);
            return e ? (
              <Sheet
                key={`breakdown-${breakdownEntry}`}
                title={`${e.name} · nutrients`}
                subtitle={`${fmtQty(e.grams)} g · ${formatMacro(entryMacros(e).kcal)} kcal`}
                onClose={() => setBreakdownEntry(null)}
              >
                <div className="px-1">
                  <NutrientBreakdown entry={e} />
                </div>
              </Sheet>
            ) : null;
          })()}
          {labelOpen && (
            <AddFoodSheet key="label" existing={store.foods} startCustom onAdd={logFromLabel} onClose={() => setLabelOpen(false)} />
          )}
        </AnimatePresence>

      </main>
    </MotionConfig>
  );
}
