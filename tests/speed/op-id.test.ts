/**
 * Grok pass 2, HIGH 3: `lib/log-commit-client.ts` runs in the browser and value-imported
 * `opIdFor` from `lib/log/contract.ts`, which imported `node:crypto`. One pure implementation now
 * serves both halves — and it has to serve them IDENTICALLY, because the whole point of the op id
 * is that a replay through the outbox and a retry through the route collapse onto one change_log
 * row.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OP_NAMESPACE, opIdFor } from "@/lib/log/op-id";

/** The derivation as lib/log/contract.ts did it before the split, byte for byte. */
function nodeOpId(entryId: string, baseRev: number | undefined): string {
  const name = `log_entries:${entryId.toLowerCase()}:${baseRev ?? 0}`;
  const ns = Buffer.from(OP_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ENTRIES = [
  "11111111-1111-4111-8111-111111111111",
  "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
  "9f1d2f7a-0c6e-4a1e-9d3b-1c2f5d8a7b10",
];

describe("opIdFor", () => {
  it("matches the node derivation the server has always used", () => {
    for (const entry of ENTRIES) {
      for (const rev of [undefined, 0, 1, 42]) {
        expect(opIdFor(entry, rev)).toBe(nodeOpId(entry, rev));
      }
    }
  });

  it("agrees at every SHA-1 padding boundary", () => {
    // 55 and 56 bytes straddle the length field, 64 is a whole block, and 119 is one byte short of
    // two. A hand-written SHA-1 that pads by luck rather than by rule passes the uuid cases above
    // and fails here (Grok pass 3). The hashed message is the 16-byte namespace plus the name,
    // which is `log_entries:` + the id + `:0` — so the id carries the length.
    for (const total of [55, 56, 64, 119]) {
      const entry = "a".repeat(total - 16 - "log_entries::0".length);
      expect(new TextEncoder().encode(`log_entries:${entry}:0`).length + 16).toBe(total);
      expect(opIdFor(entry, 0)).toBe(nodeOpId(entry, 0));
    }
  });

  it("is a v5 uuid", () => {
    expect(opIdFor(ENTRIES[0], undefined))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("reads an absent base_rev and rev 0 as the same op — a create is a create", () => {
    expect(opIdFor(ENTRIES[0], undefined)).toBe(opIdFor(ENTRIES[0], 0));
  });

  it("gives a later edit its own op", () => {
    expect(opIdFor(ENTRIES[0], 1)).not.toBe(opIdFor(ENTRIES[0], 2));
  });

  it("ignores the case of the entry id, like the server's own lower-casing", () => {
    expect(opIdFor("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", 1))
      .toBe(opIdFor("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 1));
  });
});
