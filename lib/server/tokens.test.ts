import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, hasScope, mintToken, TOKEN_PREFIX, toBytea } from "./tokens";

describe("hashToken", () => {
  it("is sha256 of the raw token, 32 bytes, collision-free", () => {
    const expected = createHash("sha256").update("smc_abc", "utf8").digest();
    expect(hashToken("smc_abc").equals(expected)).toBe(true);
    expect(hashToken("smc_abc")).toHaveLength(32);
    expect(hashToken("a").equals(hashToken("b"))).toBe(false);
  });
});

describe("hasScope", () => {
  it("matches exactly, never by prefix", () => {
    expect(hasScope(["read", "log:write"], "log:write")).toBe(true);
    expect(hasScope(["read"], "log:write")).toBe(false);
    expect(hasScope(["log:write:all"], "log:write")).toBe(false);
    expect(hasScope([], "read")).toBe(false);
  });
});

describe("mintToken", () => {
  it("prefixes smc_, never repeats, and carries the matching hash", () => {
    const { raw, hash } = mintToken();
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(raw.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash.equals(hashToken(raw))).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => mintToken().raw)).size).toBe(50);
  });
});

describe("toBytea", () => {
  it("renders the PostgREST hex literal", () => {
    expect(toBytea(Buffer.from([0x00, 0x0f, 0xff]))).toBe("\\x000fff");
  });
});
