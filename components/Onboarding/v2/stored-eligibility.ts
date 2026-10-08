"use client";

/**
 * Final Sol review BLOCK: the onboarding shell derived pace eligibility from THIS round's safety
 * taps only. An account that already holds a pace hold (a stored kidney or pregnancy condition, a
 * clinician-directed profile, the minor profile) and taps "No, none of these" still saw pace
 * chips and a preview built at that pace, while the server reads the stored answers too
 * (lib/server/target-eligibility.ts) and saves at maintenance.
 *
 * This reads the same two stored sources the server reads — the constraint row's `conditions`
 * and the account's dietary-profile instances — once per account, and merges them with the
 * round's taps, so the pace screen, the plan card and the reward preview agree with the save.
 * The shell offers no pace and saves no plan until this read has answered (a failed read stays
 * on the step with a retry): an unread account is never treated as one with no stored hold.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { accountHandle } from "@/lib/device/account";
import { loadConstraints } from "@/lib/constraints-client";
import { fetchProfileInstances } from "@/lib/profile/instances-client";
import {
  RATE_HOLDS, targetEligibility, type TargetEligibility,
} from "@/lib/profile/rate-eligibility";

/**
 * The server refused a pace (`409 rate_not_eligible`) and no read names the hold: the plan is
 * built held all the same, so the preview matches what the next save writes. `clinician_diet`
 * stands in only because it changes nothing but the pace (kidney also changes protein); the
 * plan card names no reason for it (the shell shows its own "saved health answers" note).
 */
export function serverHeldEligibility(eligibility: TargetEligibility, serverHeld: boolean): TargetEligibility {
  return serverHeld && eligibility.holds.length === 0
    ? { ...eligibility, holds: ["clinician_diet"] } : eligibility;
}

/** Both reads' holds together, in `RATE_HOLDS` order; minor when either says so. */
export function mergeEligibility(
  ...parts: readonly (TargetEligibility | null | undefined)[]
): TargetEligibility {
  const present = parts.filter((part): part is TargetEligibility => !!part);
  return {
    holds: RATE_HOLDS.filter((hold) => present.some((part) => part.holds.includes(hold))),
    minor: present.some((part) => part.minor),
  };
}

export type StoredEligibilityReads = {
  constraints: typeof loadConstraints;
  instances: typeof fetchProfileInstances;
};

const defaultReads: StoredEligibilityReads = {
  constraints: loadConstraints, instances: fetchProfileInstances,
};

/** The account's stored pace holds, the server's own read (null when either read failed). */
export async function readStoredEligibility(
  reads: StoredEligibilityReads = defaultReads,
): Promise<TargetEligibility | null> {
  const h = accountHandle();
  try {
    const [constraints, instances] = await Promise.all([
      reads.constraints({ account: h }), reads.instances(h),
    ]);
    if (!constraints) return null;
    return targetEligibility({
      conditions: constraints.profile.conditions,
      profiles: instances.instances.map((instance) => ({
        profileId: instance.profileId, source: instance.source,
      })),
    });
  } catch {
    return null;
  }
}

export type StoredEligibilityState = {
  /** The stored holds once read; null while loading and after a failed read. */
  eligibility: TargetEligibility | null;
  status: "loading" | "ready" | "failed";
  /** Reads again now and answers the holds (null on failure). The routing awaits this before it
   *  can offer a pace, so a slow or failed first read never lets a held account see one. */
  refresh: () => Promise<TargetEligibility | null>;
};

/** `readStoredEligibility` once per mount and again whenever `refresh` is called or `bump`
 *  changes (the shell bumps it after a `409 rate_not_eligible`). */
export function useStoredEligibility(
  enabled: boolean, bump = 0, reads: StoredEligibilityReads = defaultReads,
): StoredEligibilityState {
  const [state, setState] = useState<{ eligibility: TargetEligibility | null;
    status: StoredEligibilityState["status"] }>({ eligibility: null, status: "loading" });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const refresh = useCallback(async () => {
    const value = await readStoredEligibility(reads);
    if (live.current) setState({ eligibility: value, status: value ? "ready" : "failed" });
    return value;
  }, [reads]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, bump, refresh]);
  return { ...state, refresh };
}
