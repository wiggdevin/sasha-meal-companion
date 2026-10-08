"use client";

import type { DeriveTargetRevisionInput } from "@/lib/profile/derive";
import type { TargetsResponse } from "@/lib/api-types";
import {
  AccountChanged, accountHandle, currentAccountOrNull, isCurrent, rethrowAccountChanged, accountFetch,
  accountJson, type AccountHandle,
} from "@/lib/device/account";
import { loadStore, saveStoreFor } from "@/lib/store";
import { getMeta, putMeta } from "@/lib/sync/idb";
import { SYNCED_EVENT, lastError } from "@/lib/sync/client";
import { announceQueued } from "@/lib/sync/outbox";
import type { TargetRevision } from "@/lib/types";
import { settingsWithTargetRevision, targetDayFor } from "@/lib/targets/revision";

export { settingsWithTargetRevision } from "@/lib/targets/revision";

export type TargetPredecessor = {
  operation: "derive";
  input: DeriveTargetRevisionInput;
};

export type TargetRevisionSet = {
  revision: TargetRevision;
  predecessor?: TargetRevision;
};

export type TargetsGetResponse =
  | { status: "ready"; target: TargetsResponse }
  | { status: "needs_profile"; target: null };

export async function fetchTargetState(
  fetchImpl: typeof fetch = fetch, h: AccountHandle = accountHandle(),
): Promise<TargetsGetResponse> {
  // t24b: the server answers the revision in force on this phone's own day, not its zone's.
  const response = await accountFetch(h, `/api/targets?date=${targetDayFor()}`, {}, { fetchImpl });
  if (!response.ok) throw new Error(`load targets failed: ${response.status}`);
  return accountJson<TargetsGetResponse>(h, response);
}

type AuthorityBody = {
  operation: "derive";
  requestId: string;
  source: "derived" | "manual";
  effectiveFrom: string;
  latestWeighInKg: number | null;
  trainingWeekdays: number[];
  settings: {
    sex: DeriveTargetRevisionInput["settings"]["sex"];
    birthYear: DeriveTargetRevisionInput["settings"]["birthYear"];
    heightCm: DeriveTargetRevisionInput["settings"]["heightCm"];
    weightKg: DeriveTargetRevisionInput["settings"]["weightKg"];
    bodyFatPct: DeriveTargetRevisionInput["settings"]["bodyFatPct"];
    bodyFatSource: DeriveTargetRevisionInput["settings"]["bodyFatSource"];
    bodyFatMeasuredOn: DeriveTargetRevisionInput["settings"]["bodyFatMeasuredOn"];
    activityLevel: DeriveTargetRevisionInput["settings"]["activityLevel"];
    goal: DeriveTargetRevisionInput["settings"]["goal"];
    goalRateBpWeek: number | null;
    trainingKcal: number | null;
    restKcal: number | null;
    proteinG: number | null;
  };
  predecessor?: AuthorityBody;
};

export const PENDING_TARGET_REVISIONS_KEY = "pending_target_revisions";
const TARGET_RETRY_LIMIT = 20;
const TARGET_LOCK_NAME = "mc-pending-target-revisions";

export type PendingTargetRevision = {
  ownerId: string;
  requestId: string;
  body: AuthorityBody;
};

export class TargetRevisionQueuedError extends Error {
  constructor(public readonly requestId: string) {
    super("target revision queued");
    this.name = "TargetRevisionQueuedError";
  }
}

function authorityBody(
  input: DeriveTargetRevisionInput,
  requestId = crypto.randomUUID(),
): AuthorityBody {
  const settings = input.settings;
  return {
    operation: "derive",
    requestId,
    source: input.source ?? "derived",
    effectiveFrom: input.today,
    latestWeighInKg: input.latestWeighInKg,
    trainingWeekdays: [...input.trainingWeekdays],
    settings: {
      sex: settings.sex,
      birthYear: settings.birthYear,
      heightCm: settings.heightCm,
      weightKg: settings.weightKg,
      bodyFatPct: settings.bodyFatPct ?? null,
      bodyFatSource: settings.bodyFatSource ?? null,
      bodyFatMeasuredOn: settings.bodyFatMeasuredOn ?? null,
      activityLevel: settings.activityLevel,
      goal: settings.goal,
      goalRateBpWeek: settings.goalRateBpWeek ?? null,
      trainingKcal: settings.trainingKcal,
      restKcal: settings.restKcal,
      proteinG: settings.proteinG,
    },
  };
}

/**
 * A refusal the server explained with a code (onboarding v2: `422 adult_only` under 18,
 * `409 rate_not_eligible` for a held pace). The message keeps the old "save targets failed: N"
 * shape so every existing reader is unchanged.
 */
export class TargetSaveRefusedError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`save targets failed: ${status}`);
    this.name = "TargetSaveRefusedError";
  }
}

async function refusalCode(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json() as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function postRevisionSet(
  h: AccountHandle, body: object, fetchImpl: typeof fetch,
): Promise<TargetRevisionSet> {
  const response = await accountFetch(h, "/api/targets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { fetchImpl });
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      throw new TargetSaveRefusedError(response.status, await refusalCode(response));
    }
    throw new Error(`save targets failed: ${response.status}`);
  }
  const result = await accountJson<TargetsResponse & { predecessor?: TargetRevision }>(h, response);
  if (!result.revision) throw new Error("save targets returned no authority revision");
  return {
    revision: result.revision,
    ...(result.predecessor ? { predecessor: result.predecessor } : {}),
  };
}


let pendingLock: Promise<unknown> = Promise.resolve();

function withLocalLock<T>(work: () => Promise<T>): Promise<T> {
  const next = pendingLock.then(work, work);
  pendingLock = next.catch(() => undefined);
  return next;
}

function withPendingLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  return locks
    ? locks.request(TARGET_LOCK_NAME, async () => withLocalLock(work)) as Promise<T>
    : withLocalLock(work);
}

/** The queue's lock, for the legacy adoption that merges into it (PR #248 review r6 #3). */
export const withTargetQueueLock = withPendingLock;

export async function readPendingTargetRevisions(
  h: AccountHandle,
): Promise<PendingTargetRevision[]> {
  try {
    const stored = await getMeta(h, PENDING_TARGET_REVISIONS_KEY);
    return Array.isArray(stored) ? stored as PendingTargetRevision[] : [];
  } catch (e) {
    rethrowAccountChanged(e);
    return [];
  }
}

/** Replace the owner's queued revision with `entry`; answers the one it replaced. */
async function replacePendingForOwner(
  h: AccountHandle, entry: PendingTargetRevision,
): Promise<PendingTargetRevision | undefined> {
  return withPendingLock(async () => {
    const pending = await readPendingTargetRevisions(h);
    await putMeta(h, PENDING_TARGET_REVISIONS_KEY,
      [...pending.filter((item) => item.ownerId !== entry.ownerId), entry]);
    return pending.find((item) => item.ownerId === entry.ownerId);
  });
}

/** Put `previous` back (or nothing) — only while the owner's record is still `requestId`. */
async function restorePendingForOwner(
  h: AccountHandle, ownerId: string, requestId: string, previous: PendingTargetRevision | undefined,
): Promise<void> {
  await withPendingLock(async () => {
    const pending = await readPendingTargetRevisions(h);
    if (!pending.some((item) => item.ownerId === ownerId && item.requestId === requestId)) return;
    const rest = pending.filter((item) => item.ownerId !== ownerId);
    await putMeta(h, PENDING_TARGET_REVISIONS_KEY, previous ? [...rest, previous] : rest);
  });
}

/**
 * Every revision post goes through here (PR #248 review r2 #4). The newest intent is written to
 * the queue BEFORE the send, replacing the owner's older record:
 *  - accepted → it is cleared (only if no newer record replaced it meanwhile);
 *  - the answer is lost to a switch (`AccountChanged`) → it stays, and replays when the account
 *    returns — idempotent through its request id — so an older record can never replay over it;
 *  - refused or offline → a queued caller keeps it; a direct caller puts the older record back.
 */
async function sendRevision(
  h: AccountHandle, body: AuthorityBody, send: typeof fetch,
  opts: { requestId: string; queue: boolean },
): Promise<TargetRevisionSet> {
  const entry: PendingTargetRevision = { ownerId: h.userId, requestId: opts.requestId, body };
  let written = true;
  let previous: PendingTargetRevision | undefined;
  try {
    previous = await replacePendingForOwner(h, entry);
  } catch (e) {
    rethrowAccountChanged(e);
    written = false; // storage we cannot write: the send still goes, as it did before the queue
  }
  try {
    const result = await postRevisionSet(h, body, send);
    if (written) await cancelPendingTargetRevision(opts.requestId, h);
    return result;
  } catch (error) {
    if (error instanceof AccountChanged || !isCurrent(h)) throw error;
    if (opts.queue) {
      if (!written) await replacePendingForOwner(h, entry);
      announceQueued();
      throw new TargetRevisionQueuedError(opts.requestId);
    }
    if (written) await restorePendingForOwner(h, h.userId, opts.requestId, previous);
    throw error;
  }
}

export async function cancelPendingTargetRevision(
  requestId: string, h: AccountHandle = accountHandle(),
): Promise<void> {
  await withPendingLock(async () => {
    const pending = await readPendingTargetRevisions(h);
    await putMeta(h, PENDING_TARGET_REVISIONS_KEY,
      pending.filter((item) => item.requestId !== requestId));
  });
}

export async function persistDerivedTargetRevisionSet(
  input: DeriveTargetRevisionInput,
  options: {
    fetchImpl?: typeof fetch;
    predecessor?: TargetPredecessor;
    queueOnFailure?: boolean;
    account?: AccountHandle;
  } = {},
): Promise<TargetRevisionSet> {
  const h = options.account ?? accountHandle();
  const body = authorityBody(input);
  if (options.predecessor) {
    body.predecessor = authorityBody(options.predecessor.input);
  }
  return sendRevision(h, body, options.fetchImpl ?? fetch,
    { requestId: body.requestId, queue: options.queueOnFailure === true });
}

/** Posts this account's queued revisions. Records carry their owner; only the handle's own go. */
export async function drainPendingTargetRevisions(h: AccountHandle, options: {
  fetchImpl?: typeof fetch;
} = {}): Promise<{ posted: number; pending: number }> {
  const ownerId = h.userId;
  const entries = (await readPendingTargetRevisions(h))
    .filter((entry) => entry.ownerId === ownerId)
    .slice(0, TARGET_RETRY_LIMIT);
  let posted = 0;
  for (const entry of entries) {
    // A record replaced since the snapshot is superseded: never send it over the newer one.
    const queued = await readPendingTargetRevisions(h);
    if (!queued.some((item) => item.requestId === entry.requestId)) continue;
    let result: TargetRevisionSet;
    try {
      result = await postRevisionSet(h, entry.body, options.fetchImpl ?? fetch);
    } catch (e) {
      rethrowAccountChanged(e);
      continue;
    }
    await cancelPendingTargetRevision(entry.requestId, h);
    const store = loadStore();
    saveStoreFor(h, {
      ...store, settings: settingsWithTargetRevision(store.settings, result.revision),
    });
    posted += 1;
  }
  return { posted, pending: (await readPendingTargetRevisions(h))
    .filter((entry) => entry.ownerId === ownerId).length };
}

function persistTargetRevision(
  input: DeriveTargetRevisionInput,
  fetchImpl: typeof fetch = fetch,
  h: AccountHandle = accountHandle(),
): Promise<TargetRevision> {
  const body = authorityBody(input);
  return sendRevision(h, body, fetchImpl, { requestId: body.requestId, queue: false })
    .then((result) => result.revision);
}

export function persistDerivedTargetRevision(
  input: DeriveTargetRevisionInput,
  fetchImpl: typeof fetch = fetch,
  h: AccountHandle = accountHandle(),
): Promise<TargetRevision> {
  return persistTargetRevision(input, fetchImpl, h);
}

export function restoreTargetRevisionOnline(
  revisionId: string,
  effectiveFrom: string,
  fetchImpl: typeof fetch = fetch,
  h: AccountHandle = accountHandle(),
): Promise<TargetRevision> {
  // Never queued (PR #248 review r3 #3): a restore carries no request id the server dedupes on,
  // so a replay would create another revision. It is sent once, as on main.
  return postRevisionSet(h, { operation: "restore", revisionId, effectiveFrom }, fetchImpl)
    .then((result) => result.revision);
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener(SYNCED_EVENT, () => {
    // Only for the account bound now; its pass just finished (Phase 9 §0.3).
    const h = currentAccountOrNull();
    if (h === null) return;
    void lastError(h).then((error) => {
      if (error === null) void drainPendingTargetRevisions(h).catch(() => undefined);
    }).catch(() => undefined);
  });
}
