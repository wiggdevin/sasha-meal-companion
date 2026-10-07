/**
 * What an account leaves on this phone (plan decision P9; audit plan r3 finding 1): everything.
 * Sign-out and an account change delete NO account database, store, draft, scan, cache or coach
 * mark, and there is no cap on how many accounts a phone keeps: every one of them is keyed by its
 * account, and a new page binds only one (reload boundary, lib/device/departure.ts). This module
 * keeps the device registry and counts unsent work for the sign-out notice.
 */
import { openDB } from "idb";
import { ACCOUNT_KEY_PREFIX } from "./account";
import { listAccountKeys } from "./account-storage";
import { accountDbName, META_STORE, OUTBOX_STORE } from "@/lib/sync/idb";
import { PENDING_LOG_KEY } from "@/lib/log/pending";
import { PENDING_WEIGH_INS_KEY } from "@/lib/health/weigh-in-client";
import { PENDING_TARGET_REVISIONS_KEY } from "@/lib/targets/client";

/** Device registry: which accounts have used this phone, for a later cap with a proof. */
export const DEVICE_ACCOUNTS_KEY = "smc:device:accounts";

type Registered = { userId: string; lastUsedAt: number };

function readRegistry(): Registered[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICE_ACCOUNTS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is Registered =>
      typeof r?.userId === "string" && typeof r?.lastUsedAt === "number") : [];
  } catch {
    return [];
  }
}

export function touchAccount(userId: string, now: number = Date.now()): void {
  try {
    const rest = readRegistry().filter((r) => r.userId !== userId);
    localStorage.setItem(DEVICE_ACCOUNTS_KEY, JSON.stringify([...rest, { userId, lastUsedAt: now }]));
  } catch {
    // A registry that cannot be written costs the future cap its data, nothing else.
  }
}

export type PendingWork = {
  ops: number; logRecords: number; targetRevisions: number;
  weighIns: number; drafts: number; scans: number;
};

const NONE: PendingWork = { ops: 0, logRecords: 0, targetRevisions: 0, weighIns: 0, drafts: 0, scans: 0 };

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function storageWork(userId: string): Pick<PendingWork, "drafts" | "scans"> {
  const prefix = `${ACCOUNT_KEY_PREFIX}${userId}:`;
  const keys = listAccountKeys(userId).map((k) => k.slice(prefix.length));
  let scans = 0;
  try {
    scans = listLength(JSON.parse(localStorage.getItem(`${prefix}pending_scans`) ?? "[]"));
  } catch {
    scans = keys.includes("pending_scans") ? 1 : 0;
  }
  return { drafts: keys.filter((k) => k.startsWith("draft:")).length, scans };
}

/**
 * Every kind of durable unsent work of one account, for the sign-out notice only: nothing is
 * deleted on its answer. The database is opened only when `indexedDB.databases()` lists it, so this
 * never creates one (reload review r1 #5: a created-then-deleted empty database could be caught by
 * a concurrent first open and keep no stores). A browser without that API, or any failure, answers
 * "unknown".
 */
export async function pendingWork(userId: string): Promise<PendingWork | "unknown"> {
  const storage = storageWork(userId);
  try {
    if (typeof indexedDB.databases !== "function") return "unknown";
    const names = (await indexedDB.databases()).map((d) => d.name);
    if (!names.includes(accountDbName(userId))) return { ...NONE, ...storage };
    // No version: opens what exists and never upgrades it.
    const db = await openDB(accountDbName(userId));
    try {
      if (!db.objectStoreNames.contains(OUTBOX_STORE) || !db.objectStoreNames.contains(META_STORE)) {
        return "unknown";
      }
      const ops = await db.count(OUTBOX_STORE);
      const [log, weighIns, targets] = await Promise.all([PENDING_LOG_KEY, PENDING_WEIGH_INS_KEY,
        PENDING_TARGET_REVISIONS_KEY].map((key) => db.get(META_STORE, key)));
      return { ops, logRecords: listLength(log), weighIns: listLength(weighIns),
        targetRevisions: listLength(targets), ...storage };
    } finally {
      db.close();
    }
  } catch {
    return "unknown";
  }
}

export function hasPendingWork(work: PendingWork | "unknown"): boolean {
  if (work === "unknown") return true;
  return Object.values(work).some((n) => n > 0);
}

/** The sum the sign-out notice shows, or null when it cannot be known. */
export function pendingTotal(work: PendingWork | "unknown"): number | null {
  return work === "unknown" ? null : Object.values(work).reduce((a, b) => a + b, 0);
}
