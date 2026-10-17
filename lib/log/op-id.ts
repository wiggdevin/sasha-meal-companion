/**
 * The change_log op id, derived the same way on both sides of the wire.
 *
 * This is the one thing the browser and the server MUST agree on byte for byte: an offline replay
 * through the outbox and an online retry through `/api/log/commit` collapse onto one change_log
 * row only because both name the op identically. apply_sync_op answers the replay 'duplicate' from
 * its `sync_op_receipts` row (W048, migration 20270105110000), which outlives the change_log row. So there is one implementation, and it is pure —
 * no `node:crypto`, which would follow `lib/log/contract.ts` into the browser bundle and make Next
 * either fail the build or ship a polyfill (Grok pass 2, HIGH 3).
 *
 * SHA-1 is written out rather than taken from `crypto.subtle`, which is async: `opFor` in
 * lib/server/log.ts derives the id inside a synchronous builder, and an id this small and this
 * hot is not worth making every caller await. It is a name hash, never a security primitive.
 */

/** RFC 4122 §4.3 name-based uuid namespace. Fixed since Phase 2; changing it re-names every op. */
export const OP_NAMESPACE = "6f3c0f27-0e4a-41e8-9a64-2b0e0d6c9a11";

function rotl(n: number, bits: number): number {
  return ((n << bits) | (n >>> (32 - bits))) >>> 0;
}

/** RFC 3174 SHA-1 over `bytes`, as 20 bytes. */
function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  // 0x80, then zeros to 56 mod 64, then the length as a 64-bit big-endian count of bits.
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));

  let [h0, h1, h2, h3, h4] =
    [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(chunk + i * 4);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i += 1) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999]
        : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
        : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = next;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  new DataView(out.buffer).setUint32(0, h0);
  new DataView(out.buffer).setUint32(4, h1);
  new DataView(out.buffer).setUint32(8, h2);
  new DataView(out.buffer).setUint32(12, h3);
  new DataView(out.buffer).setUint32(16, h4);
  return out;
}

const HEX = "0123456789abcdef";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uuidV5(name: string, namespace: string): string {
  const ns = hexToBytes(namespace);
  const suffix = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + suffix.length);
  input.set(ns);
  input.set(suffix, ns.length);
  const bytes = sha1(input).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;      // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80;      // RFC 4122 variant
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

/**
 * The change_log op_id for this commit. Derived from entry_id and base_rev, so a replay of the
 * same create (or the same edit) is the same op and apply_sync_op answers 'duplicate' (from the
 * op's receipt, even once its change_log row is pruned); a later
 * edit carries a higher base_rev and is a new op.
 */
export function opIdFor(entryId: string, baseRev: number | undefined): string {
  return uuidV5(`log_entries:${entryId.toLowerCase()}:${baseRev ?? 0}`, OP_NAMESPACE);
}

/**
 * The user_foods id a label commit saves its food under (audit 2026-10-10 A036). Named by the
 * account and the entry, so a retried or replayed commit of one entry meets the row its first
 * attempt inserted instead of inserting a second one.
 */
export function labelFoodIdFor(userId: string, entryId: string): string {
  return uuidV5(`label_food:${userId.toLowerCase()}:${entryId.toLowerCase()}`, OP_NAMESPACE);
}
