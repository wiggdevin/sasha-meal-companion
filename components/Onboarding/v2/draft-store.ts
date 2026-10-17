"use client";

/**
 * Onboarding v2, lane 5 — a resume draft for the conversational shell, so a reload mid-setup
 * does not send the account back to a blank opener. UI territory only (no `lib/` edit): a small,
 * self-contained IndexedDB store, not the shared `lib/sync/idb.ts` machinery the outbox uses —
 * this never syncs anywhere and is wiped the moment onboarding actually finishes.
 *
 * Every entry point is wrapped in try/catch and never throws: a private window, cleared site
 * data, or a browser with IndexedDB disabled must degrade to "no draft," not break onboarding.
 *
 * Keyed by the bound account's own `userId` (GPT-6 Sol round-1 BLOCK: a single shared "current"
 * key let a second account on the same browser resume, and overwrite, the first account's draft).
 * `currentAccountOrNull()` is read fresh on every call, never cached — a draft never crosses an
 * account boundary even mid-session.
 */
import { currentAccountOrNull } from "@/lib/device/account";
import type { Settings } from "@/lib/types";

const DB_NAME = "onboarding-draft-v2";
const DB_VERSION = 1;
const STORE = "draft";

/** `null` when no account is bound — callers treat that the same as "nothing to resume." */
function draftKey(): string | null {
  return currentAccountOrNull()?.userId ?? null;
}

export type OnboardingDraft = {
  /** The last beat the shell had reached, so a resume can skip what is already answered. */
  beat: string;
  /** Every field confirmed so far, in the shape `OnboardingFlow`'s own `initialSettings` takes —
   *  the same bridge both the resume path and the error-fallback path (`OnboardingErrorBoundary`)
   *  read from. */
  settings: Partial<Settings>;
  /** Model calls this session already spent against the per-account onboarding budget
   *  (`lib/coach/onboarding-call-budget.ts`). Cheap to carry along with the rest of the draft so a
   *  reload mid-setup does not hand the account a fresh budget it has already spent. Absent on an
   *  older saved draft; callers treat that as 0. */
  callsUsed?: number;
  /** GPT-6 Sol BLOCK (onb2-p0): the "Use this plan" save's one target request id, kept across a
   *  failed attempt and a reload, so a retry after a lost target answer is the same request and
   *  the server writes one revision (`write_target_revision` dedupes on `request_id`). `key` is
   *  what the request says: a changed answer is a new request and gets a new id. */
  targetRequest?: { id: string; key: string };
  savedAt: string;
};

/** In memory, per account: the id still holds when this browser cannot store a draft at all. */
const heldTargetRequests = new Map<string, { id: string; key: string }>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

/** Never throws: any failure (no IndexedDB, a closed database, a blocked upgrade) is swallowed —
 *  the caller treats a failed save the same as "nothing to resume yet," not an onboarding error. */
export async function saveOnboardingDraft(draft: Omit<OnboardingDraft, "savedAt">): Promise<void> {
  const key = draftKey();
  if (key === null) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        // Read and write in one transaction: the beat/facts autosave must never drop the save's
        // target request id a concurrent "Use this plan" just stored.
        const read = store.get(key);
        read.onsuccess = () => {
          const before = read.result as OnboardingDraft | undefined;
          const targetRequest = draft.targetRequest ?? before?.targetRequest;
          store.put({ ...draft, ...(targetRequest ? { targetRequest } : {}),
            savedAt: new Date().toISOString() }, key);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB write failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Best-effort only — see module doc.
  }
}

/** A draft older than this is treated as missing (W150): the setup it describes is long cold. */
export const DRAFT_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

function isStale(draft: OnboardingDraft, now = Date.now()): boolean {
  const savedAt = Date.parse(draft.savedAt);
  return !Number.isFinite(savedAt) || now - savedAt > DRAFT_MAX_AGE_MS;
}

/** The stored record as it is, whatever its age. `null` on any failure or an empty store. */
async function readDraft(key: string): Promise<OnboardingDraft | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<OnboardingDraft | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(key);
        request.onsuccess = () => resolve((request.result as OnboardingDraft | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error("indexedDB read failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * `null` on any failure, an empty store or a draft older than 21 days — never thrown, same
 * fail-soft contract as the save. A stale draft is deleted, except that a pending `targetRequest`
 * is kept on its own (no beat, no answers), so a lost "Use this plan" save is not posted twice.
 * The age check and the delete are one readwrite transaction, so an autosave landing between them
 * is never overwritten.
 */
export async function loadOnboardingDraft(): Promise<OnboardingDraft | null> {
  const key = draftKey();
  if (key === null) return null;
  try {
    const db = await openDb();
    try {
      return await new Promise<OnboardingDraft | null>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const request = store.get(key);
        let result: OnboardingDraft | null = null;
        request.onsuccess = () => {
          const draft = (request.result as OnboardingDraft | undefined) ?? null;
          if (draft === null) return;
          if (!isStale(draft)) { result = draft; return; }
          if (draft.targetRequest) {
            store.put({ beat: "", settings: {}, targetRequest: draft.targetRequest, savedAt: draft.savedAt }, key);
          } else store.delete(key);
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB read failed"));
        tx.onabort = () => reject(tx.error ?? new Error("indexedDB read aborted"));
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The key a "Use this plan" save's target request id is kept under: the answers the request is
 * built from, and NOT the day (final Sol review BLOCK: a target POST that committed just before
 * midnight and lost its answer was retried just after it under a new id, so the server wrote a
 * second revision). The server answers a known request id with the revision it already wrote.
 */
export function onboardingTargetRequestKey(state: unknown, safety: unknown): string {
  return JSON.stringify({ state, safety });
}

/**
 * The target request id for a "Use this plan" save whose request reads `requestKey`: the stored
 * one when the key matches (a retry, also after a reload), else a new id, stored before it is
 * returned so the first attempt and every retry send the same id. Never throws; with no usable
 * storage the id is held in memory for this page.
 */
export async function onboardingTargetRequestId(requestKey: string): Promise<string> {
  const account = draftKey();
  const held = account === null ? undefined : heldTargetRequests.get(account);
  if (held?.key === requestKey) return held.id;
  const draft = await loadOnboardingDraft();
  // A stale draft reads as missing, but its pending request id still counts.
  const stored = draft?.targetRequest ?? (account === null ? undefined : (await readDraft(account))?.targetRequest);
  if (stored?.key === requestKey) {
    if (account !== null) heldTargetRequests.set(account, stored);
    return stored.id;
  }
  const targetRequest = { id: crypto.randomUUID(), key: requestKey };
  if (account !== null) heldTargetRequests.set(account, targetRequest);
  await saveOnboardingDraft({
    beat: draft?.beat ?? "reward", settings: draft?.settings ?? {},
    ...(draft?.callsUsed !== undefined ? { callsUsed: draft.callsUsed } : {}), targetRequest,
  });
  return targetRequest.id;
}

/** Called once onboarding actually finishes (or is explicitly skipped) — a stale draft must
 *  never resurrect an old, already-completed setup on a later first-run check. */
export async function clearOnboardingDraft(): Promise<void> {
  const key = draftKey();
  if (key === null) return;
  heldTargetRequests.delete(key);
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB delete failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Best-effort only — see module doc.
  }
}
