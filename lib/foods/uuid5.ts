/**
 * RFC 4122 version 5 UUIDs — SHA-1 over `<namespace bytes><name bytes>`, version and variant
 * stamped into the digest.
 *
 * There is no `uuid` package in this repo and no Web Crypto `randomUUID` equivalent for the
 * name-based form, so this is the one implementation; `lib/foods/adopt-client.ts` minted bundled
 * food ids with a private copy of it before T1 and now calls in here instead.
 *
 * Pure apart from `crypto.subtle`, which both the browser and Node expose as a global.
 */

const HEX = "0123456789abcdef";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

/** The v5 id of `name` inside `namespace`. Same inputs, same id, on every device and every run. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const prefix = uuidToBytes(namespace);
  const suffix = new TextEncoder().encode(name);
  const input = new Uint8Array(prefix.length + suffix.length);
  input.set(prefix);
  input.set(suffix, prefix.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
