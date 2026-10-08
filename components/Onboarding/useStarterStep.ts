"use client";

import { useEffect, useState } from "react";
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "@/lib/device/account";
import { loadStore } from "@/lib/store";
import { loadConstraints } from "@/lib/constraints-client";
import { loadRuleReview } from "@/lib/rule-review-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import { initialStarterSelection, starterChoices, type Starter, type StarterMark } from "@/lib/foods/starter";
import type { OnboardingState } from "@/lib/profile/onboarding-state";

/**
 * One account-rules read, shared by the hook's own effect and `reread()` below (ONB2-RULE-REREAD).
 * Returns `null` on any failure (offline, a pending rule review, an account switch mid-await) —
 * the caller must then treat the selection as unverified, never fall back to a stale list.
 */
async function readStarterChoices(
  h: AccountHandle, flags: readonly string[],
): Promise<Starter[] | null> {
  const [constraints, review, profiles] = await Promise.all([
    loadConstraints({ account: h }), loadRuleReview({ account: h }), fetchProfileInstances(h),
  ]);
  if (!constraints || !review || review.required) return null;
  assertCurrent(h);
  return starterChoices(flags, constraints.profile, profiles.instances);
}

/** `preselectDefaults: false` (onboarding v2's love round): start with nothing marked, so only foods
 *  the person tapped (or named, or already saved) are saved. The legacy form keeps its defaults.
 *  Live QA 2026-10-07: v2 never showed the 29 pre-marked defaults, yet saved them all as Eats. */
export function useStarterStep(state: OnboardingState | null, enabled = true,
  options: { preselectDefaults?: boolean } = {}) {
  const preselectDefaults = options.preselectDefaults ?? true;
  const [choices, setChoices] = useState<Starter[] | null>(null);
  const [marks, setMarks] = useState<Record<string, StarterMark>>({});
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const step = state?.step;
  const flags = state?.flags.join("|") ?? "";
  const text = state?.prefsText ?? "";
  useEffect(() => {
    if (!enabled) return;
    if (step !== 4 && step !== 5) return;
    let live = true;
    const h = currentAccountOrNull();
    if (!h) return;
    const key = `${h.userId}\0${flags}\0${text}\0${revision}`;
    if (loadedFor === key) return;
    const activeFlags = flags ? flags.split("|") : [];
    Promise.all([loadConstraints({ account: h }), loadRuleReview({ account: h }),
      fetchProfileInstances(h)]).then(([constraints, review, profiles]) => {
      if (!live) return;
      if (!constraints || !review || review.required) {
        setError(review?.required
          ? "Review your food rules in Foods › Avoids before choosing suggestions."
          : "Couldn’t verify your food rules. Retry when you’re online.");
        setChoices(null);
        return;
      }
      assertCurrent(h);
      const safe = starterChoices(activeFlags, constraints.profile, profiles.instances);
      setLoadedFor(key);
      setChoices(safe);
      setMarks(initialStarterSelection(activeFlags, constraints.profile, text, profiles.instances,
        Object.values(loadStore().foods), { preselectDefaults }));
      setError(null);
    }).catch(() => {
      if (live) { setChoices(null); setError("Couldn’t verify your food rules. Retry when you’re online."); }
    });
    return () => { live = false; };
  }, [enabled, step, flags, text, revision, loadedFor, preselectDefaults]);
  const account = currentAccountOrNull();
  const current = enabled && account !== null
    && loadedFor === `${account.userId}\0${flags}\0${text}\0${revision}`;
  /**
   * ONB2-RULE-REREAD (Sol r6 BLOCK on onb2-l4-r2): the rendered `choices` above can be minutes
   * stale by the time FoodsStep's "I'm done" confirms — a rule saved mid-flow (e.g. through the
   * inline rule editor a dietary-text jump opens, which writes constraints directly and never
   * touches `flags`/`text`) would not retrigger the effect above, so the confirm could still write
   * an now-excluded food as "eats". `reread()` re-reads the account's rules right now, independent
   * of the hook's own memoized key, and hands the caller the FRESH list to gate the write on — never
   * the stale closure. It also updates the hook's own state so the rendered choices/marks catch up.
   */
  async function reread(): Promise<Starter[] | null> {
    const h = currentAccountOrNull();
    if (!h) return null;
    const activeFlags = flags ? flags.split("|") : [];
    let fresh: Starter[] | null;
    try {
      fresh = await readStarterChoices(h, activeFlags);
    } catch {
      fresh = null;
    }
    if (currentAccountOrNull()?.userId !== h.userId) return null;
    if (fresh === null) {
      setError("Couldn’t verify your food rules. Retry when you’re online.");
      setChoices(null);
      return null;
    }
    setChoices(fresh);
    setError(null);
    // Drop (never silently keep) any "eats" mark the fresh rules no longer allow, so a rule saved
    // mid-flow can never reveal the food it just excluded to the write path below.
    const allowed = new Set(fresh.map((item) => item.id));
    setMarks((previous) => {
      const next: Record<string, StarterMark> = {};
      for (const [id, mark] of Object.entries(previous)) {
        next[id] = mark === "eats" && !allowed.has(id) ? "neutral" : mark;
      }
      return next;
    });
    setRevision((value) => value + 1);
    setLoadedFor(`${h.userId}\0${flags}\0${text}\0${revision + 1}`);
    return fresh;
  }
  return { choices: current ? choices : null, marks, error,
    retry: () => setRevision((value) => value + 1),
    reread,
    mark: (id: string, value: StarterMark) => setMarks((previous) => ({ ...previous, [id]: value })) };
}
