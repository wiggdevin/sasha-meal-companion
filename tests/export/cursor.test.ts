import { describe, expect, it, vi } from "vitest";

// lib/server/export.ts imports "server-only", which throws outside a server component (see
// tests/log/commit.test.ts). Only the marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { decodeCursor, encodeCursor } = await import("@/lib/server/export");

describe("export cursor", () => {
  it("round-trips the keyset triple", () => {
    const cursor = { local_date: "2026-09-17", eaten_at: "2026-09-18T02:30:00.000Z",
      id: "00000000-0000-4000-8000-000000000011" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is url-safe", () => {
    const encoded = encodeCursor({ local_date: "2026-09-17",
      eaten_at: "2026-09-18T02:30:00.000Z", id: "00000000-0000-4000-8000-000000000011" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("throws a 422 on a malformed cursor", () => {
    expect(() => decodeCursor("not-base64-json")).toThrow(/cursor/);
    expect(() => decodeCursor(Buffer.from('{"local_date":1}').toString("base64url")))
      .toThrow(/cursor/);
  });
});
