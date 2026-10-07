import { describe, expect, it } from "vitest";
import { uuidV5 } from "./uuid5";

/** RFC 4122 appendix B / the DNS namespace vector every v5 implementation is checked against. */
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidV5", () => {
  // Both vectors cross-checked against Python's `uuid.uuid5` (stdlib), not against this file.
  it("matches the published DNS-namespace test vector", async () => {
    expect(await uuidV5(DNS_NAMESPACE, "www.example.com"))
      .toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(await uuidV5(DNS_NAMESPACE, "onion"))
      .toBe("394f0588-0b3b-5240-83c1-e559a643db81");
  });

  it("stamps version 5 and the RFC 4122 variant", async () => {
    const id = await uuidV5(DNS_NAMESPACE, "anything at all");
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
  });

  it("is deterministic and namespace-scoped", async () => {
    const a = await uuidV5(DNS_NAMESPACE, "onion");
    const b = await uuidV5(DNS_NAMESPACE, "onion");
    const other = await uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "onion");
    expect(a).toBe(b);
    expect(other).toBe("ed171e2d-51a7-5c93-9f42-fccaa6ce962e");
  });

  it("refuses a namespace that is not a uuid", async () => {
    await expect(uuidV5("not-a-uuid", "x")).rejects.toThrow(/not a uuid/);
  });
});
