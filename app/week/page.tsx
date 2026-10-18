"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import WeekGrid from "@/components/week/WeekGrid";
import ShareButton from "@/components/ShareButton";
import { computeWeekStats } from "@/lib/summary";
import { resolveStripDay } from "@/lib/today/resolve-strip-day";
import { loadEligibleLocalFoodIds } from "@/lib/foods/eligible-client";
import { currentAccountOrNull } from "@/lib/device/account";
import { loadStore } from "@/lib/store";
import { formatWeight, lbToKg, type WeightUnit } from "@/lib/health/units";
import type { Store } from "@/lib/types";
import { SYNCED_EVENT } from "@/lib/sync/client";

/**
 * The Week tab. PRD §6.2 — 7 columns, unbounded scroll in both directions
 * (no start date, no end date, per PRD §1.1), two headline numbers, gut/weight
 * shown compactly when logged, plus the share action.
 *
 * GAP NOTE FOR THE BUILD REPORT: nothing in the logic layer turns a stored
 * day into the `ResolvedDay` the UI renders — plan.ts, targets.ts, meals.ts
 * and scaling.ts each do one piece. lib/rotation.ts (owned by neither) is the
 * date/slot -> meal seam; it does NOT know about Floor Day, so this file
 * layers that in itself (`floorMealForSlot` below) rather than editing that
 * shared seam. `resolveDay` is the remaining composition (targets, portion
 * scaling, eaten/consumed totals) needed to get a `ResolvedDay` — kept
 * private to this file since the Today screen may need the same composition
 * and building it independently avoids two screens colliding on one module.
 */

// -------------------------------------------------------------- date math

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO(): string {
  return isoOf(new Date());
}

function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + delta);
  return isoOf(next);
}

export function formatWeekWeight(weightLb: number, unit: WeightUnit): string {
  return formatWeight(lbToKg(weightLb), unit);
}

/** The Monday on or before `date` — weeks in this app run Monday..Sunday. */
function mostRecentMonday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sun .. 6 = Sat
  return addDays(date, -((dow + 6) % 7));
}

// ------------------------------------------------------------- the system
//
// Every value below is copied from the already-themed screens, not invented:
// EYEBROW from EatsReference.tsx, the caption/count sizes from MyFoods.tsx,
// the Chevron and the header title class from
// app/page.tsx (Today). No mockup exists for this screen — DESIGN.md is the
// contract: glass cards, olive for emphasis, ink primary button.

const EYEBROW = "text-overline uppercase text-muted";
const STAT_CAPTION = "text-tiny font-normal text-muted";

/** Prev / next chevrons, 1.5px stroke, copied from app/page.tsx. */
/** A thin gauge under a week stat, in that macro's colour (DESIGN.md gauges): how much of the target
 *  the number covers, capped at full. */
function StatBar({ tone, share }: { tone: "protein" | "calories"; share: number }) {
  const width = `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
  return <span className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-fog" aria-hidden="true">
    <span className="block h-full rounded-full" style={{ width,
      background: `linear-gradient(90deg, var(--color-gauge-${tone}), var(--color-gauge-${tone}-end))` }} />
  </span>;
}

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={back ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

// ------------------------------------------------------------------ page

export default function WeekPage() {
  const [today, setToday] = useState(todayISO);
  const [weekOffset, setWeekOffset] = useState(0);

  // "Today" follows local midnight while the page stays open, as Today's own clock does: a check
  // each minute and on every return to the tab (audit A070). The same string never re-renders.
  useEffect(() => {
    const roll = () => setToday(todayISO());
    const onVisible = () => { if (document.visibilityState === "visible") roll(); };
    const interval = window.setInterval(roll, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  const [store, setStore] = useState<Store | null>(null);

  // localStorage never runs during SSR (store.ts is SSR-safe by returning a
  // default), but reading it during the first client render risks a
  // hydration mismatch against the server-rendered markup — so it is loaded
  // in an effect instead. Refreshing on focus/visibility picks up changes
  // made on the Today tab without requiring an app restart.
  useEffect(() => {
    // This is exactly React's own documented exception ("subscribing to an
    // external store") — the lint rule's cascading-render concern doesn't
    // apply to a one-time synchronous load on mount, and moving it to a
    // lazy useState initializer would run before hydration and reintroduce
    // the mismatch this effect exists to avoid.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(loadStore());
    function refresh() {
      if (document.visibilityState === "visible") setStore(loadStore());
    }
    const onSynced = () => setStore(loadStore());
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(SYNCED_EVENT, onSynced);
    };
  }, []);

  // The verified Eats Today generates meals from (UI audit 2026-10-18): without them /week had no
  // generated meals, so a past day Today's strip reads "missed" read "unplanned" here and the stats
  // scored a different plan. Read once the store is in, and again after every sync pass; a failed
  // read resolves days as stored, as before.
  const [eligible, setEligible] = useState<{ state: "loading" | "ready" | "failed"; ids?: ReadonlySet<string> }>(
    { state: "loading" });
  const storeLoaded = store !== null;
  useEffect(() => {
    if (!storeLoaded) return;
    const account = currentAccountOrNull();
    let live = true;
    // A burst of sync passes starts several reads; only the latest one's answer is kept.
    let latest = 0;
    const read = async () => {
      if (!account) { setEligible({ state: "failed" }); return; }
      const mine = ++latest;
      try {
        const ids = await loadEligibleLocalFoodIds(account, loadStore().foods);
        if (live && mine === latest && currentAccountOrNull()?.epoch === account.epoch) setEligible({ state: "ready", ids });
      } catch {
        if (live && mine === latest) setEligible((previous) => previous.state === "ready" ? previous : { state: "failed" });
      }
    };
    void read();
    const onSynced = () => { void read(); };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => { live = false; window.removeEventListener(SYNCED_EVENT, onSynced); };
  }, [storeLoaded]);

  const weekStart = useMemo(() => addDays(mostRecentMonday(today), weekOffset * 7), [today, weekOffset]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekDays = useMemo(
    () => (store && eligible.state !== "loading"
      ? weekDates.map((date) => resolveStripDay(store, date, eligible.state === "ready"
        // Generation still waits for rule review: the stored gate decides, as on Today.
        ? { eligibleFoodIds: eligible.ids, accepted: null, recipeAccessEnabled: false,
          ruleReviewReady: store.settings.ruleReviewReady === true }
        : undefined))
      : []),
    [store, weekDates, eligible]
  );
  const stats = useMemo(() => computeWeekStats(weekDays, today), [weekDays, today]);
  const weightUnit = store?.settings.weightUnit ?? "lb";
  // lib/summary.ts scores every past day of the week, touched or not. On a
  // first open that reads "0% · 0/1 days" — the app marking an account down for a
  // day before it existed. Until some past day in this week has a tick,
  // show a dash and say so plainly. Presentation only; the numbers are
  // summary.ts's.
  const weekHasLoggedPastDay = weekDays.some(
    (d) => d.date < today && (d.slots.some((s) => s.eaten) || d.extras.length > 0)
  );
  const weekHasTargets = weekDays.some((day) => day.targets !== null);

  return (
    <main
      className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
      style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}
    >
      <header className="flex flex-col gap-2.5 px-1">
        <div className="flex min-h-11 items-center justify-end">
          <Link href="/" aria-label="Back to Today"
            className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-graphite">
            <CloseIcon />
          </Link>
        </div>

        <h1 className="ground m-0 text-display-md font-light leading-none tracking-display-md">
          Week
        </h1>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setWeekOffset((w) => w - 1)}
            className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-graphite"
          >
            <Chevron back />
          </button>
          <span className=" truncate text-caption font-normal text-graphite">
            {stats.rangeLabel || "—"}
          </span>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => setWeekOffset((w) => w + 1)}
            className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-graphite"
          >
            <Chevron />
          </button>
        </div>
      </header>

      {weekDays.length === 0
        ? <p role="status" className={`m-0 px-1 ${STAT_CAPTION}`}>Loading your week…</p>
        : <WeekGrid days={weekDays} today={today} />}

      {/* The two numbers that matter — PRD §6.2, deliberately not a wall of
          stats. Glass cards (`.shell` + `.surface`) with an eyebrow label and
          a 40 px/300 numeral, per DESIGN.md Typography. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="shell flex">
          <div className="surface flex w-full flex-col gap-1 p-4">
            <p className={`m-0 flex items-center gap-1.5 ${EYEBROW}`}>
              <span className="size-1.5 rounded-full bg-gauge-protein" aria-hidden="true" />Protein
            </p>
            <p className=" m-0 text-display-md font-light leading-none tracking-display-md tabular-nums text-charcoal">
              {weekHasTargets && stats.proteinHitRate && weekHasLoggedPastDay
                ? `${stats.proteinHitRate.pct}%` : "—"}
            </p>
            <p className={`m-0 tabular-nums ${STAT_CAPTION}`}>
              {weekHasTargets && stats.proteinHitRate && weekHasLoggedPastDay
                ? `hit-rate · ${stats.proteinHitRate.met}/${stats.proteinHitRate.total} days`
                : "hit-rate · nothing logged yet"}
            </p>
            <StatBar tone="protein" share={weekHasTargets && stats.proteinHitRate && weekHasLoggedPastDay
              ? stats.proteinHitRate.pct / 100 : 0} />
          </div>
        </div>
        <div className="shell flex">
          <div className="surface flex w-full flex-col gap-1 p-4">
            <p className={`m-0 flex items-center gap-1.5 ${EYEBROW}`}>
              <span className="size-1.5 rounded-full bg-gauge-calories" aria-hidden="true" />Calories
            </p>
            <p className=" m-0 text-display-md font-light leading-none tracking-display-md tabular-nums text-charcoal">
              {weekHasTargets && stats.calories && weekHasLoggedPastDay
                ? stats.calories.avg.toLocaleString("en-US") : "—"}
            </p>
            <p className={`m-0 tabular-nums ${STAT_CAPTION}`}>
              {weekHasTargets && stats.calories && weekHasLoggedPastDay
                ? `average · target ${stats.calories.target.toLocaleString("en-US")}`
                : "average · fills in from tomorrow"}
            </p>
            <StatBar tone="calories" share={weekHasTargets && stats.calories && weekHasLoggedPastDay
              && stats.calories.target > 0 ? stats.calories.avg / stats.calories.target : 0} />
          </div>
        </div>
      </div>

      {weekHasTargets && stats.overTargetDays.length > 0 && (
        <p className={`m-0 px-1 ${STAT_CAPTION}`}>
          Above calorie target: {stats.overTargetDays.join(", ")}
        </p>
      )}

      {(stats.gut || stats.weight) && (
        <div className="flex flex-wrap gap-2 px-1">
          {stats.gut && (
            <span className="pill inline-flex">
              <span className="pill-in  flex items-center px-3.5 py-2 text-tiny font-normal text-graphite">
                Gut: {stats.gut.good} good · {stats.gut.iffy} iffy · {stats.gut.flare} flare
              </span>
            </span>
          )}
          {stats.weight && (
            <span className="pill inline-flex">
              <span className="pill-in  flex items-center px-3.5 py-2 text-tiny font-normal text-graphite">
                Weight:{" "}
                {stats.weight.count === 1
                  ? formatWeekWeight(stats.weight.first, weightUnit)
                  : `${formatWeekWeight(stats.weight.first, weightUnit)} → ${
                    formatWeekWeight(stats.weight.last, weightUnit)}`}
              </span>
            </span>
          )}
        </div>
      )}

      <ShareButton weekDays={weekDays} today={today} />
    </main>
  );
}
