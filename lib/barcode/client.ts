/**
 * The browser half of the barcode path, plus the wire types both halves share (the server reads
 * them with `import type`, so nothing browser-shaped reaches the server bundle).
 *
 * scanGtin distinguishes three outcomes on purpose. A BarcodeResponse is an answer, including
 * `not_found`. A transport failure, a 429 or a 5xx is ScanUnavailable — the sheet falls back to
 * the IndexedDB cache and, failing that, queues the scan. A 400 is BarcodeRejected: the camera
 * read something that is not a GTIN, and the user has to see that rather than a silent retry.
 */
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { isDeadline } from "@/lib/fetch-with-deadline";
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { mark, type TimingRun } from "@/lib/timing";
import type { PolicyVerdict } from "@/lib/policy/constraints";
import type { Provenance } from "@/lib/types";

export { resolveOffline } from "@/lib/barcode/scan-cache";

export type BarcodeRequest = { gtin: string; hint?: { brand?: string; name?: string } };

export type BarcodeMatch = {
  foodRefId: string; catalogFoodId: number; revisionId: number;
  description: string; brand: string | null;
  source: "fdc_foundation" | "fdc_sr_legacy" | "fdc_fndds" | "fdc_branded" | "off";
  qualityClass: "analytical" | "survey" | "label" | "crowd";
  qualityFlags: string[];
  /** null = not measured, 0 = measured zero (architecture §3.3). */
  per100g: Record<string, number | null>;
  portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
  ingredientsText: string | null;
  allergenTags: string[];
  attribution: string | null;
  policy: PolicyVerdict;
};

export type BarcodeResponse = (
  | { status: "resolved"; gtin14: string; cached: boolean; match: BarcodeMatch }
  | { status: "ambiguous"; gtin14: string; cached: boolean; matches: BarcodeMatch[] }
  | { status: "not_found"; gtin14: string; searchHint: { brand?: string; name?: string } }
) & {
  /** A barcode match is catalog data, never a model's read (lib/types.ts `Provenance`). */
  provenance?: Provenance;
};

export type BarcodeError = {
  error: "invalid_gtin" | "unauthorized" | "rate_limited" | "upstream_unavailable";
  retryAfterMs?: number;
};

/** The six symbologies on a grocery package. zxing-wasm spells Code 128 "Code128". */
export const SCAN_FORMATS = ["EAN-8", "UPC-A", "UPC-E", "EAN-13", "ITF", "Code128"] as const;

export type ScanRequest = { id: number; data: ImageData };
/** `error: true` means the decoder itself failed on this frame (wasm/module/internal error) —
 * distinct from a clean `results: []` meaning nothing was in frame. */
export type ScanReply = { id: number; results: { text: string; format: string }[]; error?: true };

export class ScanUnavailable extends Error {
  constructor(public gtin14: string, public retryAfterMs?: number) {
    super("The scan service is unreachable.");
    this.name = "ScanUnavailable";
  }
}

export class BarcodeRejected extends Error {
  constructor(public code: BarcodeError["error"]) {
    super("That is not a barcode we can read.");
    this.name = "BarcodeRejected";
  }
}

export async function scanGtin(
  req: BarcodeRequest,
  opts: { fetchImpl?: typeof fetch; run?: TimingRun; account?: AccountHandle } = {}
): Promise<BarcodeResponse> {
  const h = opts.account ?? accountHandle();
  // The scanner has already marked `decode` and hands its run back in; this is the next hop of
  // THAT run, closed by whichever commit follows (T0 §1). Without the handle a second scan
  // started while this one is still resolving joins this run and the two taps come out as one.
  mark("barcode", "lookup", opts.run);
  let res: Response;
  try {
    // A scan past the 8 s budget is unreachable as far as the sheet is concerned: it falls back
    // to the IndexedDB cache and, failing that, queues the scan — the ScanUnavailable path.
    res = await accountFetch(h, "/api/foods/barcode", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(req),
    }, { budget: "barcode", fetchImpl: opts.fetchImpl });
  } catch (e) {
    rethrowAccountChanged(e);
    throw new ScanUnavailable(req.gtin);
  }
  // The budget covers the body, so a scan can run out of it after the headers. That is the same
  // unreachable service the sheet already falls back from (Grok pass 26, HIGH 2).
  if (res.ok) {
    try {
      return await accountJson<BarcodeResponse>(h, res);
    } catch (e) {
      rethrowAccountChanged(e);
      throw new ScanUnavailable(req.gtin);
    }
  }
  if (res.status === 400) {
    let body: Partial<BarcodeError> = {};
    try {
      body = await accountJson<Partial<BarcodeError>>(h, res);
    } catch (e) {
      rethrowAccountChanged(e);
      if (isDeadline(e)) throw new ScanUnavailable(req.gtin);
    }
    throw new BarcodeRejected(body.error ?? "invalid_gtin");
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  throw new ScanUnavailable(req.gtin, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
}

/**
 * A match, flattened into the row buildCommitRequest and computeSnapshot take. `version_label`
 * carries the attribution string so the ODbL notice survives into the offline snapshot's
 * source_version, which is what the food detail screen and a CSV export read (AC 12).
 */
export function toCachedRevision(
  match: BarcodeMatch,
  gtin14: string,
  now: number = Date.now()
): CachedRevision {
  return {
    revision_id: match.revisionId,
    catalog_food_id: match.catalogFoodId,
    description: match.description,
    brand: match.brand,
    source: match.source,
    version_label: match.attribution ?? match.source,
    per_100g: match.per100g,
    portions: match.portions,
    gtin14,
    food_ref_id: match.foodRefId,
    allergen_tags: match.allergenTags,
    policy: match.policy,
    cached_at: new Date(now).toISOString(),
  };
}

/**
 * The offline twin of a resolved response: a match rebuilt from the cache, for a repeat scan with
 * no signal. It returns null rather than fabricating a food_ref — a commit without one queues an op
 * that can never apply (AC 5). The full ingredients text is not cached, but the allergen tags and
 * policy verdict the online scan already computed are, so a known-blocked product still shows
 * blocked offline instead of downgrading to a generic "unverified" warning. A row cached before
 * these fields existed falls back to "unverified", same as before.
 */
export function offlineMatch(cached: CachedRevision): BarcodeMatch | null {
  if (!cached.food_ref_id) return null;
  return {
    foodRefId: cached.food_ref_id,
    catalogFoodId: cached.catalog_food_id,
    revisionId: cached.revision_id,
    description: cached.description,
    brand: cached.brand,
    source: cached.source as BarcodeMatch["source"],
    qualityClass: "crowd",
    qualityFlags: [],
    per100g: cached.per_100g,
    portions: cached.portions,
    ingredientsText: null,
    allergenTags: cached.allergen_tags ?? [],
    attribution: cached.version_label,
    policy: cached.policy ?? { verdict: "unverified" },
  };
}
