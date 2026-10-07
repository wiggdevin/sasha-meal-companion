"use client";

/**
 * The data half of `/body` (Sol third round, finding 7): one fetch spanning `TDEE_WINDOW_DAYS`
 * (15 inclusive days) for the TDEE lines, its newest 7 days for the sparklines, the nightly
 * estimate, and the shared body profile. Kept out of `app/body/page.tsx` so the page component is
 * a view and no function in either file runs long.
 */
import { accountHandle, currentAccountOrNull } from "@/lib/device/account";
import { useCallback, useEffect, useState } from "react";
import { useBodyProfile, type BodyProfileRead } from "@/lib/body-profile-client";
import { chartDays, TDEE_WINDOW_DAYS } from "@/lib/body-window";
import { fetchExpenditure, fetchProposals, fetchTargets, type Fresh } from "@/lib/estimator-client";
import { fetchDaily } from "@/lib/health-client";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { ExpenditureResponse, ProposalSummary } from "@/lib/api-types";
import { loadStore, saveStore } from "@/lib/store";

/** Local yyyy-mm-dd, `offsetDays` from `now` (0 is today, negative is earlier). */
export function isoDate(offsetDays: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The one fetch window `/body` asks for: today and the 14 days the weight rule looks back. */
export function windowRange(now: Date = new Date()): { from: string; to: string } {
  return { from: isoDate(-(TDEE_WINDOW_DAYS - 1), now), to: isoDate(0, now) };
}

/** `fetchDaily`'s settled result, or null before the first one lands. */
export type DailyResult = Awaited<ReturnType<typeof fetchDaily>> | null;

export type BodyDashboardData = { daily: DailyResult; chart: DailyHealthRow[];
  estimate: ExpenditureResponse | null; pendingProposal: Fresh<ProposalSummary[]> | null;
  profile: BodyProfileRead; reload: () => void;
  onProposalDecided: (decision: "approve" | "reject") => void };

export function useBodyDashboard(): BodyDashboardData {
  const [daily, setDaily] = useState<DailyResult>(null);
  const [estimate, setEstimate] = useState<ExpenditureResponse | null>(null);
  const [pendingProposal, setPendingProposal] = useState<Fresh<ProposalSummary[]> | null>(null);
  const profile = useBodyProfile();

  const reload = useCallback(async () => {
    const { from, to } = windowRange();
    setDaily(await fetchDaily(accountHandle(), from, to));
  }, []);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    const { from, to } = windowRange();
    // A result for an account that has since gone is dropped (the fetch rejects).
    void fetchDaily(h, from, to)
      .then((next) => { if (live) setDaily(next); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    void fetchExpenditure(h)
      .then((fresh) => { if (live) setEstimate(fresh?.value ?? null); }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    void fetchProposals(h)
      .then((next) => { if (live) setPendingProposal(next); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const onProposalDecided = useCallback(async (decision: "approve" | "reject") => {
    setPendingProposal(null);
    if (decision !== "approve") return;
    const targets = await fetchTargets();
    if (targets.id === "ramp") return;
    const current = loadStore();
    saveStore({
      ...current,
      settings: {
        ...current.settings,
        activeTargetProfile: { training: targets.resolved.training, rest: targets.resolved.rest },
        updatedAt: new Date().toISOString(),
      },
    });
  }, []);

  return { daily, chart: chartDays(daily?.response?.days ?? []), estimate, pendingProposal,
    profile, reload, onProposalDecided };
}
