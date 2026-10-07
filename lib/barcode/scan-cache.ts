/**
 * The offline half of the scan path (spec "Client changes" → Offline, AC 5). Every resolved
 * barcode is written into the existing catalog_revisions store with its GTIN attached, so a
 * repeat scan in airplane mode resolves from the phone and logs. A scan we could not resolve is
 * queued under localStorage rather than failing silently, and replayed when the link returns.
 */
import { evictOlderThan, getByGtin, putRevision, type CachedRevision } from "@/lib/db/catalog-cache";
import {
  accountHandle, accountKey, currentAccountOrNull, isCurrent, type AccountHandle,
} from "@/lib/device/account";

/** The bound account's queue (Phase 9 §0.4): `smc:u:<userId>:pending_scans`. */
export const PENDING_SCANS_NAME = "pending_scans";

export function pendingScansKey(): string | null {
  const h = currentAccountOrNull();
  return h === null ? null : accountKey(h, PENDING_SCANS_NAME);
}
export type PendingScan = { gtin14: string; at: string };

/** How long a scanned revision stays trustworthy offline before it is dropped rather than served stale. */
export const SCAN_CACHE_RETENTION_DAYS = 30;

/** Cached for the account that scanned (`h`); a stale handle writes nothing (Phase 9 §0.2). */
export async function rememberScan(
  gtin14: string, revision: CachedRevision, h: AccountHandle = accountHandle(),
): Promise<void> {
  await putRevision({ ...revision, gtin14 }, h);
  await evictOlderThan(SCAN_CACHE_RETENTION_DAYS, Date.now(), h);
}

export async function resolveOffline(
  gtin14: string, h: AccountHandle = accountHandle(),
): Promise<CachedRevision | null> {
  const row = await getByGtin(gtin14, h);
  if (!row) return null;
  const ageMs = Date.now() - Date.parse(row.cached_at);
  if (ageMs > SCAN_CACHE_RETENTION_DAYS * 86_400_000) return null;
  return row;
}

export function readPendingScans(): PendingScan[] {
  const key = pendingScansKey();
  if (key === null) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingScan[]) : [];
  } catch {
    return [];
  }
}

function writePendingScans(rows: PendingScan[]): void {
  const key = pendingScansKey();
  if (key === null) return;
  try {
    localStorage.setItem(key, JSON.stringify(rows));
  } catch {
    /* private browsing: the queue is a convenience, never the log itself */
  }
}

/** One row per GTIN; the first sighting keeps its timestamp. */
export function addPendingScan(gtin14: string, at: string = new Date().toISOString()): void {
  const rows = readPendingScans();
  if (rows.some((r) => r.gtin14 === gtin14)) return;
  writePendingScans([...rows, { gtin14, at }]);
}

export function clearPendingScan(gtin14: string): void {
  writePendingScans(readPendingScans().filter((r) => r.gtin14 !== gtin14));
}

/** Replay on reconnect. Returns the unsubscribe the sheet calls on unmount. */
export function startPendingScanReplay(replay: (gtin14: string) => Promise<void>): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = (): void => {
    // The queue of the account bound now; a replay answered after a switch clears nothing.
    const h = currentAccountOrNull();
    for (const row of readPendingScans()) {
      void replay(row.gtin14).then(
        () => { if (h !== null && isCurrent(h)) clearPendingScan(row.gtin14); },
        () => {/* still unreachable: the row stays queued for the next online event */}
      );
    }
  };
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}
