"use client";

import { useEffect, useState } from "react";
import type { Food } from "@/lib/foods";
import { loadEligibleLocalFoodIds, type StampedEligibleSet } from "@/lib/foods/eligible-client";
import { readPrefRefCache } from "@/lib/foods/prefs-client";
import { currentEligibleView, foodRulesKey, type EligibleView } from "@/lib/foods/rule-marks";
import { foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { currentAccountOrNull, isAccountClosing, onAccountGone } from "@/lib/device/account";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { RuleMark, Settings } from "@/lib/types";

/** The list's one line when its rows cannot say whether a food fits the rules. */
export const EATS_RULES_UNCHECKED = "Can't check your foods against your rules right now.";
export const EATS_RULES_CHECKING = "Checking your foods against your updated rules.";
/** Before the first answer: rows carry no marks yet, and the list says the check is under way. */
export const EATS_RULES_FIRST_CHECK = "Checking your foods against your rules.";
/** A refresh failed: the rows keep the marks of the last good read, which may have moved since. */
export const EATS_RULES_STALE = "Can't check your foods against your rules right now. Marks may be out of date.";
/** A failed read is retried on a later sync with the same inputs no sooner than this. */
export const ELIGIBLE_RETRY_MS = 30_000;
/** A good read is refreshed this often while the list is open and visible (an interval timer), and
 *  a sync pass refreshes it no more often than this, so a rule changed on another device reaches an
 *  open list (the route allows 30 reads a minute). */
export const ELIGIBLE_REFRESH_MS = 120_000;
/** An answer the server could not judge is read again on its own after 30 s, then every 2 min. */
export const UNJUDGED_RETRY_MS = [30_000, 120_000] as const;
/** An Eats food the verified read neither cleared nor marked (just added, or its membership has not
 *  reached the server): unchecked, never clear. */
export const EATS_NOT_CHECKED = "Not checked against your food rules yet.";

/**
 * Why an Eats food is not being suggested: the server-verified eligible set's mark for it
 * (`/api/foods/eligible` `excluded[]`, projected by lib/foods/eligible-client.ts). The server's whole
 * sentence (`excluded[].mark`, kept as `sentences`) is shown as sent. Only when an entry carries no
 * well-formed `mark` (an older server) is the fragment reason ("has peanut, which your rules
 * exclude.") given its food's name, the way lib/foods/rule-marks.ts `componentRuleMark` does. Only
 * a food on Eats. A mark never hides the row or blocks a tap.
 */
export function eatsRuleMark(food: Food,
  view: Pick<EligibleView, "marks"> & Partial<Pick<EligibleView, "ids">> | undefined,
  sentences?: ReadonlyMap<string, RuleMark>): RuleMark | null {
  if (food.status !== "eats") return null;
  const mark = view?.marks.get(food.id);
  const sentence = sentences?.get(food.id);
  if (mark && sentence?.verdict === mark.verdict) return sentence;
  if (mark) return { verdict: mark.verdict, reason: `${food.name.trim() || "This food"} ${mark.reason}` };
  // With the read's clears in hand, a food it did not clear is unchecked (fail closed).
  if (view?.ids && !view.ids.has(food.id)) return { verdict: "unknown", reason: EATS_NOT_CHECKED };
  return null;
}

/**
 * What the eligible read depends on: the rules epoch, the phone's diet flags, and each Eats food with
 * the refs it is checked by. A sync pass that moved none of them needs no new read (the route is
 * rate-limited, and SYNCED_EVENT fires on every pass).
 */
export function eligibleInputsKey(foods: Record<string, Food>, refs: ReturnType<typeof readPrefRefCache>,
  settings: Pick<Settings, "dietPrefs">, epoch: number): string {
  const eats = Object.values(foods).filter((food) => food.status === "eats")
    .map((food) => [food.id, food.name, refs[food.id]?.userRefId ?? "", refs[food.id]?.catalogRefId ?? ""].join("\u0001"))
    .sort();
  return JSON.stringify([epoch, foodRulesKey(settings), eats]);
}

type ReadState = { set: StampedEligibleSet | null; failed: boolean; pending: boolean };

export type EatsRuleMarks = {
  markFor: (food: Food) => RuleMark | null;
  /** One quiet line for the list when rows would otherwise look cleared without being checked. */
  notice: { tone: "neutral" | "attention"; title: string } | null;
};

/**
 * The verified set behind the Eats rows: read on open, every 2 min while the list is visible, and
 * on a sync pass whose inputs changed (deduped, with backoff). It fails closed and says so: before the
 * first answer the list says it is checking; a failed refresh keeps the last marks and says they may
 * be out of date; a set a rule change revoked shows "Checking…" until the re-read lands; an answer
 * the server could not judge shows the unknown marks it sent and is read again on its own; and a
 * food no read cleared carries its own Check.
 */
export function useEatsRuleMarks(foods: Record<string, Food> | null,
  settings: () => Pick<Settings, "dietPrefs"> = () => loadStore().settings): EatsRuleMarks {
  const [read, setRead] = useState<ReadState>({ set: null, failed: false, pending: false });
  useEffect(() => {
    const account = currentAccountOrNull();
    if (!account) return;
    let live = true;
    let inFlight = false;
    let again = false;
    let lastKey: string | null = null;
    let lastOk = false;
    let lastAttempt = 0;
    /** Answers in a row the server could not judge under the phone's diet flags. */
    let unjudged = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const wait = () => (!lastOk ? ELIGIBLE_RETRY_MS
      : unjudged > 0 ? UNJUDGED_RETRY_MS[Math.min(unjudged, UNJUDGED_RETRY_MS.length) - 1] : ELIGIBLE_REFRESH_MS);
    const active = () => live && !isAccountClosing() && currentAccountOrNull()?.epoch === account.epoch;
    /** `force`: the open list's refresh timer, which reads whatever the inputs. */
    const run = async (force = false) => {
      if (!active()) return;
      if (inFlight) { again = true; return; }
      const store = loadStore();
      const key = eligibleInputsKey(store.foods, readPrefRefCache(account.userId), store.settings,
        foodRulesEpoch());
      // Same inputs: read again only once the last read is old enough (refresh, retry or backoff).
      if (!force && key === lastKey && Date.now() - lastAttempt < wait()) return;
      if (retry) { clearTimeout(retry); retry = null; }
      inFlight = true;
      lastKey = key;
      lastAttempt = Date.now();
      setRead((current) => ({ ...current, pending: true }));
      try {
        const next = await loadEligibleLocalFoodIds(account, store.foods);
        lastOk = true;
        unjudged = next.rulesKey === foodRulesKey(store.settings) ? 0 : unjudged + 1;
        if (active()) setRead({ set: next, failed: false, pending: false });
        // Not judged (the server could not read its evidence): not final, so it is read again.
        if (unjudged > 0 && active()) retry = setTimeout(() => { retry = null; void run(); }, wait());
      } catch {
        // A failed or rate-limited read keeps the marks it had; the list says the check is missing.
        lastOk = false;
        if (active()) setRead((current) => ({ ...current, failed: true, pending: false }));
      } finally {
        inFlight = false;
        if (again && active()) { again = false; void run(); }
      }
    };
    void run();
    const onSynced = () => { void run(); };
    window.addEventListener(SYNCED_EVENT, onSynced);
    // While the list is open and visible, an idle list still picks up rules changed elsewhere.
    let refresh: ReturnType<typeof setInterval> | null = null;
    const stopRefresh = () => { if (refresh) clearInterval(refresh); refresh = null; };
    const startRefresh = () => {
      stopRefresh();
      if (document.visibilityState !== "hidden") refresh = setInterval(() => { void run(true); }, ELIGIBLE_REFRESH_MS);
    };
    const onVisibility = () => {
      startRefresh();
      // Back in view: a read older than the refresh step is read again now (the usual dedupe).
      if (document.visibilityState !== "hidden") void run();
    };
    startRefresh();
    document.addEventListener("visibilitychange", onVisibility);
    const offGone = onAccountGone(() => { live = false; stopRefresh(); setRead({ set: null, failed: false, pending: false }); });
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      stopRefresh();
      window.removeEventListener(SYNCED_EVENT, onSynced);
      document.removeEventListener("visibilitychange", onVisibility);
      offGone();
    };
  }, []);
  return eatsMarksFrom(foods, read, settings);
}

function eatsMarksFrom(foods: Record<string, Food> | null, { set, failed, pending }: ReadState,
  settings: () => Pick<Settings, "dietPrefs">): EatsRuleMarks {
  const eats = foods ? Object.values(foods).filter((food) => food.status === "eats") : [];
  const none: EatsRuleMarks = { markFor: () => null, notice: null };
  if (!foods || eats.length === 0) return none;
  const current = set && !set.revoked ? set : null;
  const view = current ? currentEligibleView(foods, settings(), current) : undefined;
  // A failed refresh keeps the last good marks and says they may be out of date until a read lands.
  if (view) {
    return { markFor: (food) => eatsRuleMark(food, view, current?.sentences),
      notice: failed ? { tone: "attention", title: EATS_RULES_STALE } : null };
  }
  const unchecked = { tone: "attention" as const, title: EATS_RULES_UNCHECKED };
  const checking = { tone: "neutral" as const, title: EATS_RULES_CHECKING };
  if (current) {
    // Judged under other diet flags, or not judged at all (the server could not read its evidence):
    // its "unknown" marks still hold, nothing it clears or blocks does, so every other row is
    // unchecked, and the list says the check is missing.
    const unknowns = { marks: new Map([...current.marks].filter(([, mark]) => mark.verdict === "unknown")),
      ids: new Set<string>() };
    return { markFor: (food) => eatsRuleMark(food, unknowns, current.sentences), notice: pending ? checking : unchecked };
  }
  if (set) return { markFor: () => null, notice: failed && !pending ? unchecked : checking };
  return { markFor: () => null,
    notice: failed ? unchecked : { tone: "neutral", title: EATS_RULES_FIRST_CHECK } };
}
