"use client";

/**
 * The barcode path for a photo from the dock's Camera or Upload (U18, 2026-10-04). The Scan tile is
 * gone; a picked photo is read for a barcode first (lib/barcode/still.ts). A code the catalog knows
 * becomes the same `barcode` attachment the live scanner sends; a code with several products asks
 * which one; anything else (no code, an unknown code, offline, an unreadable one) leaves the photo
 * to the AI as a plate, menu or label, where "This was a nutrition label" can still re-read it.
 */
import { attachmentMoment } from "@/components/coach/attachments/context";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";
import { resolveScan } from "@/lib/barcode/resolve-scan";
import { readBarcodeFromStill } from "@/lib/barcode/still";
import type { CoachAttachment } from "@/lib/coach/attachments";
import { currentAccountOrNull } from "@/lib/device/account";

export function barcodeAttachment(response: BarcodeResponse, match: BarcodeMatch, at: Date): CoachAttachment {
  const moment = attachmentMoment(at);
  return {
    kind: "barcode",
    v: 1,
    gtin14: response.gtin14,
    foodRefId: match.foodRefId,
    revisionId: String(match.revisionId),
    localDate: moment.localDate,
    slot: moment.slot,
    scannedAt: at.toISOString(),
  };
}

export type PhotoBarcode =
  | { kind: "product"; attachment: CoachAttachment; text: string }
  | { kind: "choose"; response: Extract<BarcodeResponse, { status: "ambiguous" }> }
  /** Send the photo the usual way. */
  | { kind: "photo" }
  /** The account changed while this ran: do nothing at all. */
  | { kind: "gone" };

export type PhotoBarcodeDeps = {
  read?: typeof readBarcodeFromStill;
  resolve?: typeof resolveScan;
  account?: typeof currentAccountOrNull;
  now?: () => Date;
};

export async function barcodeInPhoto(file: Blob, deps: PhotoBarcodeDeps = {}): Promise<PhotoBarcode> {
  const gtin = await (deps.read ?? readBarcodeFromStill)(file);
  if (!gtin) return { kind: "photo" };
  const h = (deps.account ?? currentAccountOrNull)();
  if (!h) return { kind: "photo" };
  let outcome: Awaited<ReturnType<typeof resolveScan>>;
  try {
    outcome = await (deps.resolve ?? resolveScan)(h, gtin, undefined, undefined);
  } catch {
    return { kind: "photo" };
  }
  if (outcome.kind === "gone") return { kind: "gone" };
  if (outcome.kind !== "resolved") return { kind: "photo" };
  const response = outcome.response;
  if (response.status === "resolved") {
    return { kind: "product", text: `Scanned ${response.match.description}`,
      attachment: barcodeAttachment(response, response.match, (deps.now ?? (() => new Date()))()) };
  }
  if (response.status === "ambiguous") return { kind: "choose", response };
  return { kind: "photo" };
}
