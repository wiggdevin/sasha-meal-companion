/**
 * GS1 GTIN-14 normalisation (architecture §3.1: "GTIN is normalised to GTIN-14
 * with check-digit validation"). EAN-8, UPC-A and EAN-13 left-pad with zeros;
 * the mod-10 check digit is verified against the padded form, so every accepted
 * value is a single comparable key for `catalog_barcodes.gtin14`.
 */

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * The mod-10 check digit for the first 13 digits of a GTIN-14. Weights 3,1,3,1… from the left.
 * The single implementation of this loop — `lib/barcode/gtin.ts` reuses it rather than
 * duplicating it (contracts §2, "reuse it, never duplicate the check-digit code").
 */
export function mod10CheckDigit(body13: string): number {
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    sum += Number(body13[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function toGtin14(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!GTIN_LENGTHS.has(digits.length)) return null;
  const padded = digits.padStart(14, "0");
  if (/^0{14}$/.test(padded)) return null;
  const check = mod10CheckDigit(padded.slice(0, 13));
  return check === Number(padded[13]) ? padded : null;
}
