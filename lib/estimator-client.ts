"use client";

/**
 * Client-side estimator state. Estimate and proposal payloads are cached in `localStorage` with an
 * "as of" stamp so the cards render offline (contracts §3; no IndexedDB store of their own —
 * `lib/sync/idb.ts` already mirrors the pulled rows).
 *
 * Approval is ONLINE ONLY. Targets are never merged (§3.7), so an outbox approval could apply
 * against a profile that has since changed; this is the one place the app refuses to queue.
 */
import {
  accountHandle, rethrowAccountChanged, accountFetch, accountJson, type AccountHandle,
} from "@/lib/device/account";
import { readAccountItem, removeAccountItem, writeAccountItem } from "@/lib/device/account-storage";
import { enqueue } from "@/lib/sync/outbox";
import { targetDayFor } from "@/lib/targets/revision";
import type { Entity, SyncOp } from "@/lib/sync/types";
import type {
  DecideResponse, ExpenditureResponse, ProposalSummary, TargetsRequest, TargetsResponse,
} from "@/lib/api-types";

/** The account's own cache names (Phase 9 §0.4): `smc:u:<userId>:expenditure` / `:proposals`. */
export const EXPENDITURE_CACHE_NAME = "expenditure";
export const PROPOSALS_CACHE_NAME = "proposals";
/** F-091: the trend line needs 20 weigh-ins before it means anything. */
export const MIN_WEIGH_INS_FOR_TREND = 20;

export const PULL_ONLY_ENTITIES: ReadonlySet<Entity> =
  new Set<Entity>(["target_profiles", "target_proposals"]);

export class PullOnlyEntityError extends Error {
  constructor(public readonly entity: Entity) {
    super(`${entity} is pull-only — the server writes it and the client never queues an op`);
    this.name = "PullOnlyEntityError";
  }
}

/** The guard the outbox itself does not carry: Lane Q owns this file, not `lib/sync/outbox.ts`. */
export async function enqueueGuarded(h: AccountHandle, op: SyncOp): Promise<ReturnType<typeof enqueue>> {
  if (PULL_ONLY_ENTITIES.has(op.entity)) throw new PullOnlyEntityError(op.entity);
  return enqueue(h, op);
}

export type Cached<T> = { asOf: string; value: T };

export function readCache<T>(h: AccountHandle, name: string): Cached<T> | null {
  try {
    const raw = readAccountItem(h, name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    return typeof parsed?.asOf === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** A full or disabled store is not a reason to fail the screen; a stale handle writes nothing. */
export function writeCache<T>(h: AccountHandle, name: string, value: T, asOf: string): void {
  writeAccountItem(h, name, JSON.stringify({ asOf, value } satisfies Cached<T>));
}

export type Fresh<T> = Cached<T> & { stale: boolean };

/** A response that arrives after the account changed rejects `AccountChanged`, cached for nobody,
 *  and never falls back to the new account's cache (audit plan r1 finding 2). */
async function fetchCached<T>(
  h: AccountHandle, name: string, url: string, fetchFn: typeof fetch = fetch,
): Promise<Fresh<T> | null> {
  // "Saved on" names the phone's day, never the UTC date (audit A051).
  const today = targetDayFor();
  try {
    const res = await accountFetch(h, url, { headers: { accept: "application/json" } },
      { fetchImpl: fetchFn });
    if (!res.ok) throw new Error(String(res.status));
    const value = await accountJson<T>(h, res);
    writeCache(h, name, value, today);
    return { asOf: today, value, stale: false };
  } catch (e) {
    rethrowAccountChanged(e);
    const cached = readCache<T>(h, name);
    return cached ? { ...cached, stale: true } : null;
  }
}

export function fetchExpenditure(h: AccountHandle, fetchFn: typeof fetch = fetch) {
  return fetchCached<ExpenditureResponse>(h, EXPENDITURE_CACHE_NAME, "/api/expenditure", fetchFn);
}

export function fetchProposals(h: AccountHandle, fetchFn: typeof fetch = fetch) {
  return fetchCached<ProposalSummary[]>(h, PROPOSALS_CACHE_NAME, "/api/proposals?status=pending",
    fetchFn);
}

export async function decideProposalOnline(
  proposalId: string, decision: "approve" | "reject", fetchFn: typeof fetch = fetch,
): Promise<DecideResponse> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new Error("Needs a connection");
  }
  const h = accountHandle();
  const res = await accountFetch(h, `/api/proposals/${proposalId}/decide`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, expectedStatus: "pending" }),
  }, { fetchImpl: fetchFn });
  if (!res.ok) throw new Error(`decide failed: ${res.status}`);
  removeAccountItem(h, PROPOSALS_CACHE_NAME);
  return accountJson<DecideResponse>(h, res);
}

/**
 * Spec acceptance criterion 3: no empty state, because the component does not mount.
 *
 * An exp-3 row says in `phase` whether its trend is real: `provisional` and `adaptive` have passed
 * the engine's own weigh-in rules (≥ 6 weigh-in days over ≥ 11 days in 14, or ≥ 12 over ≥ 24 in 28),
 * so the old 20-weigh-in count, which would hide a valid every-other-day line, does not apply;
 * `starting` has no trend. A `held` night stays in its phase and keeps the line it already drew.
 * An exp-2 row, or a payload cached before `phase` existed, keeps the status rule (F-091).
 */
export function shouldMountWeightTrend(
  status: ExpenditureResponse["status"], weighInCount: number,
  phase: ExpenditureResponse["phase"] = null,
): boolean {
  if (phase === "provisional" || phase === "adaptive") return true;
  if (phase === "starting") return false;
  return status !== "burn_in" && weighInCount >= MIN_WEIGH_INS_FOR_TREND;
}

/** F-077: a failed request rejects instead of resolving `null` — `null` is reserved for
 *  "nothing loaded yet" (the caller's pre-fetch state), so it must never also mean "failed". */
export async function fetchTargets(fetchFn: typeof fetch = fetch): Promise<TargetsResponse> {
  const h = accountHandle();
  const res = await accountFetch(h, `/api/targets?date=${targetDayFor()}`, { headers: { accept: "application/json" } },
    { fetchImpl: fetchFn });
  if (!res.ok) throw new Error(`fetch targets failed: ${res.status}`);
  return accountJson<TargetsResponse>(h, res);
}

export async function postTargets(
  req: TargetsRequest, fetchFn: typeof fetch = fetch,
): Promise<TargetsResponse> {
  const h = accountHandle();
  const res = await accountFetch(h, "/api/targets", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
  }, { fetchImpl: fetchFn });
  if (!res.ok) throw new Error(`save targets failed: ${res.status}`);
  return accountJson<TargetsResponse>(h, res);
}

/** Grams and an approximate percent split, seeded from the server's resolved training-day macros
 *  (architecture §3.4: protein and fat round to the nearest gram, carbs take the remainder, so the
 *  three percentages sum to exactly 100). Only used to give TargetModeSheet a starting point when
 *  Settings opens it. */
export function targetsToSheetInitial(t: TargetsResponse): {
  mode: "grams" | "percent"; kcalTrain: number; kcalRest: number;
  grams: { proteinG: number; fatG: number; carbG: number };
  percent: { proteinPct: number; fatPct: number; carbPct: number };
} {
  const kcalTrain = t.resolved.training.kcal;
  const kcalRest = t.resolved.rest.kcal;
  const grams = {
    proteinG: t.resolved.training.protein,
    fatG: t.resolved.training.fat,
    carbG: t.resolved.training.carbs,
  };
  const proteinPct = Math.round((grams.proteinG * 4 / kcalTrain) * 100);
  const fatPct = Math.round((grams.fatG * 9 / kcalTrain) * 100);
  const carbPct = 100 - proteinPct - fatPct;
  return { mode: t.mode, kcalTrain, kcalRest, grams, percent: { proteinPct, fatPct, carbPct } };
}

/** Contracts §6: NEXT_PUBLIC_ESTIMATOR_UI unset means the Settings estimator group and the Targets
 *  sheet never render, even once /api/expenditure has real data. */
export function visibleEstimate(estimate: Fresh<ExpenditureResponse> | null): ExpenditureResponse | null {
  if (!process.env.NEXT_PUBLIC_ESTIMATOR_UI) return null;
  return estimate?.value ?? null;
}

/** Same gate, for the Today proposal card; also hidden when there is no pending proposal, or when
 *  the row at [0] has already been decided (approved/rejected) and a stale cache or a late reload
 *  has not cleared it yet — only a "pending" row is ever shown. */
export function visibleProposal(pendingProposal: Fresh<ProposalSummary[]> | null): ProposalSummary | null {
  if (!process.env.NEXT_PUBLIC_ESTIMATOR_UI) return null;
  const first = pendingProposal?.value[0];
  return first?.status === "pending" ? first : null;
}

/** Whether Settings' "Targets — grams or percent" control can open TargetModeSheet: only once
 *  /api/targets has actually returned something — never a sheet with nothing to show. */
export function canOpenTargetsSheet(targets: TargetsResponse | null): boolean {
  return targets !== null;
}
