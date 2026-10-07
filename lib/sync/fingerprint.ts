/**
 * Duplicate-entry fingerprint — contracts §4.1 (frozen bytes):
 *   sha256(local_date | slot | floor(epoch(eaten_at)/900) | sorted(canonical_id:floor5(grams)))
 * Bucketing is FLOOR, not round — 102 g and 104 g both bucket to 100, not 100 and 105. Event
 * time, not arrival time, so the answer does not depend on which device synced first.
 */

export type FingerprintInput = {
  localDate: string; slot: string; eatenAt: string;
  /**
   * `grams` null: an unknown mass (t17). Such an item hashes as `<id>:u<qty><unit>` — its count —
   * and never as 0 g. A known mass hashes exactly as before (frozen bytes).
   */
  items: { canonicalFoodId: string; grams: number | null; qty?: number; unit?: string }[];
};

const BUCKET_SECONDS = 900;
const GRAM_STEP = 5;

function floor5(grams: number): number {
  return Math.floor(grams / GRAM_STEP) * GRAM_STEP;
}

/** The exact bytes that get hashed. Pure and synchronous, so the formula is testable on its own. */
export function fingerprintSource(input: FingerprintInput): string {
  const epoch = Date.parse(input.eatenAt);
  if (Number.isNaN(epoch)) throw new TypeError(`entryFingerprint: eatenAt is not a date (${input.eatenAt})`);
  const bucket = Math.floor(epoch / 1000 / BUCKET_SECONDS);
  const items = input.items.map((i) => (i.grams === null
    ? `${i.canonicalFoodId}:u${i.qty ?? "?"}${i.unit ?? ""}`
    : `${i.canonicalFoodId}:${floor5(i.grams)}`)).sort();
  return `${input.localDate}|${input.slot}|${bucket}|${items.join(",")}`;
}

/** Web Crypto where present (browsers, and Node ≥ 19 so vitest too); node:crypto only as a fallback for older runtimes. */
async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function entryFingerprint(input: FingerprintInput): Promise<string> {
  return sha256Hex(fingerprintSource(input));
}
