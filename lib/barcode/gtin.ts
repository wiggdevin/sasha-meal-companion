/**
 * GTIN helpers for the scan path. `normalizeGtin` is NOT reimplemented here: Phase 1's
 * lib/search/gtin.ts already pads 8/12/13/14 digits to GTIN-14 and verifies the mod-10 digit
 * against the padded form, and two copies of a check-digit loop is one copy too many
 * (contracts §2, "reuse it, never duplicate the check-digit code").
 */
import { mod10CheckDigit, toGtin14 } from "@/lib/search/gtin";

export { toGtin14 as normalizeGtin } from "@/lib/search/gtin";

/**
 * The mod-10 digit for the first 13 digits of a GTIN-14. Delegates to the one shared loop in
 * lib/search/gtin.ts rather than re-implementing it (contracts §2).
 */
export function gtinCheckDigit(body13: string): number {
  if (!/^[0-9]{13}$/.test(body13)) {
    throw new RangeError("gtinCheckDigit needs exactly 13 digits");
  }
  return mod10CheckDigit(body13);
}

export function isGtin(raw: string): boolean {
  return toGtin14(raw) !== null;
}

/**
 * The form OFF and FDC store. Both keep barcodes as printed and normalise UPC-A to EAN-13, so a
 * lookup sends the 13-digit form and only a real ITF-14 keeps its 14th digit. The GTIN-14 stays
 * the single key on our side — this value never reaches the database.
 */
export function providerCode(gtin14: string): string {
  const significant = gtin14.replace(/^0+/, "");
  return significant.length <= 13 ? significant.padStart(13, "0") : gtin14;
}
