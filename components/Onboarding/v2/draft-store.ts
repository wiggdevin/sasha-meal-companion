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
  savedAt: string;
};

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
        tx.objectStore(STORE).put({ ...draft, savedAt: new Date().toISOString() }, key);
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

/** `null` on any failure or an empty store — never thrown, same fail-soft contract as the save. */
export async function loadOnboardingDraft(): Promise<OnboardingDraft | null> {
  const key = draftKey();
  if (key === null) return null;
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

/** Called once onboarding actually finishes (or is explicitly skipped) — a stale draft must
 *  never resurrect an old, already-completed setup on a later first-run check. */
export async function clearOnboardingDraft(): Promise<void> {
  const key = draftKey();
  if (key === null) return;
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
