"use client";

/**
 * The data half of `/body` (Sol third round, finding 7): one fetch spanning `TDEE_WINDOW_DAYS`
 * (15 inclusive days) for the TDEE lines, its newest 7 days for the sparklines, the nightly
 * estimate, and the shared body profile. Kept out of `app/body/page.tsx` so the page component is
 * a view and no function in either file runs long.
 */
import { accountHandle, currentAccountOrNull } from "@/lib/device/account";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBodyProfile, type BodyProfileRead } from "@/lib/body-profile-client";
import { chartDays, TDEE_WINDOW_DAYS } from "@/lib/body-window";
import { fetchExpenditure, fetchProposals, fetchTargets, type Fresh } from "@/lib/estimator-client";
import { fetchDaily } from "@/lib/health-client";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { ExpenditureResponse, ProposalSummary } from "@/lib/api-types";
import { loadStore, saveStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";

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

/** Where the nightly estimate read stands, so the page can tell "still loading" from "failed". */
export type EstimateStatus = "loading" | "ready" | "error";

export type BodyDashboardData = { daily: DailyResult; chart: DailyHealthRow[];
  estimate: ExpenditureResponse | null; estimateStatus: EstimateStatus;
  retryEstimate: () => void; pendingProposal: Fresh<ProposalSummary[]> | null;
  profile: BodyProfileRead; reload: () => void;
  onProposalDecided: (decision: "approve" | "reject") => void };

export function useBodyDashboard(): BodyDashboardData {
  const [daily, setDaily] = useState<DailyResult>(null);
  const [estimate, setEstimate] = useState<ExpenditureResponse | null>(null);
  const [estimateStatus, setEstimateStatus] = useState<EstimateStatus>("loading");
  const [estimateRead, setEstimateRead] = useState(0);
  const [pendingProposal, setPendingProposal] = useState<Fresh<ProposalSummary[]> | null>(null);
  const profile = useBodyProfile();
  /** Only the newest daily read may land: a slow answer never paints over a newer one. */
  const dailyRead = useRef(0);

  const reload = useCallback(async () => {
    const read = ++dailyRead.current;
    const { from, to } = windowRange();
    const next = await fetchDaily(accountHandle(), from, to);
    if (read === dailyRead.current) setDaily(next);
  }, []);

  // The days follow every sync pass — a weigh-in from another device, or this one's queued weigh-in
  // posting — like the profile does. The nightly estimate and proposals change only overnight.
  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    // One read at a time: passes that arrive while one is out ask for a single read after it, so a
    // burst of passes costs two requests and no older answer can land after a newer one.
    let busy = false;
    let again = false;
    const read = () => {
      if (busy) { again = true; return; }
      busy = true;
      const mine = ++dailyRead.current;
      const { from, to } = windowRange();
      // A result for an account that has since gone is dropped (the fetch rejects).
      void fetchDaily(h, from, to)
        .then((next) => { if (live && mine === dailyRead.current) setDaily(next); }, () => {})
        .finally(() => {
          busy = false;
          if (live && again) { again = false; read(); }
        });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    return () => { live = false; window.removeEventListener(SYNCED_EVENT, read); };
  }, []);

  useEffect(() => {
    const h = currentAccountOrNull();
    if (h === null) return;
    let live = true;
    // No answer and no cached copy is a failure, never an empty panel (UI audit 2026-10-18).
    void fetchExpenditure(h).then((fresh) => {
      if (!live) return;
      setEstimate(fresh?.value ?? null);
      setEstimateStatus(fresh ? "ready" : "error");
    }, () => { if (live) setEstimateStatus("error"); });
    return () => { live = false; };
  }, [estimateRead]);

  const retryEstimate = useCallback(() => {
    setEstimateStatus("loading");
    setEstimateRead((n) => n + 1);
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

  return { daily, chart: chartDays(daily?.response?.days ?? []), estimate, estimateStatus,
    retryEstimate, pendingProposal,
    profile, reload, onProposalDecided };
}
