/**
 * One accepted barcode reading, resolved for the account that scanned it (Phase 9 §0.2; PR #248
 * review r1 #6). The lookup, the offline cache, the offline fallback and the retry queue all run
 * for that handle; once another account is bound the answer is `gone` and nothing is written.
 */
import { AccountChanged, isCurrent, type AccountHandle } from "@/lib/device/account";
import {
  BarcodeRejected, ScanUnavailable, offlineMatch, scanGtin, scanRulesStamp, toCachedRevision,
  type BarcodeResponse,
} from "@/lib/barcode/client";
import { addPendingScan, rememberScan, resolveOffline } from "@/lib/barcode/scan-cache";
import type { TimingRun } from "@/lib/timing";

export type ScanOutcome =
  | { kind: "resolved"; response: BarcodeResponse }
  | { kind: "unreadable" }
  | { kind: "offline" }
  /** The account changed while this scan ran: show nothing, write nothing. */
  | { kind: "gone" };

export async function resolveScan(
  h: AccountHandle, gtin: string, hint: { brand?: string; name?: string } | undefined,
  run: TimingRun | undefined, opts: { fetchImpl?: typeof fetch } = {},
): Promise<ScanOutcome> {
  // Taken before the lookup: a verdict is stored under the rules it may have been computed under.
  const stamp = scanRulesStamp();
  try {
    const response = await scanGtin({ gtin, hint }, { run, account: h, fetchImpl: opts.fetchImpl });
    if (response.status === "resolved") {
      try {
        await rememberScan(response.gtin14,
          toCachedRevision(response.match, response.gtin14, Date.now(), stamp), h);
      } catch (e) {
        if (e instanceof AccountChanged) return { kind: "gone" };
        /* the cache is a convenience, never the log itself */
      }
    }
    return isCurrent(h) ? { kind: "resolved", response } : { kind: "gone" };
  } catch (e) {
    if (e instanceof AccountChanged || !isCurrent(h)) return { kind: "gone" };
    if (e instanceof BarcodeRejected) return { kind: "unreadable" };
    if (!(e instanceof ScanUnavailable)) throw e;
    return offline(h, e.gtin14);
  }
}

async function offline(h: AccountHandle, gtin14: string): Promise<ScanOutcome> {
  try {
    const cached = await resolveOffline(gtin14, h);
    const match = cached ? offlineMatch(cached) : null;
    if (match) return { kind: "resolved", response: { status: "resolved", gtin14, cached: true, match } };
    if (!isCurrent(h)) return { kind: "gone" };
    addPendingScan(gtin14); // the bound account is still the one that scanned
    return { kind: "offline" };
  } catch (e) {
    if (e instanceof AccountChanged) return { kind: "gone" };
    throw e;
  }
}
