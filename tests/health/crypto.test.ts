import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOauth, sealOauth } from "@/lib/server/crypto";

const KEY = randomBytes(32);
const TOKENS = { access_token: "oura-access", refresh_token: "oura-refresh",
  expires_at: "2026-09-15T15:00:00.000Z", scope: "daily personal" };

describe("sealOauth / openOauth", () => {
  it("round-trips and never leaves the plaintext visible", () => {
    const sealed = sealOauth(TOKENS, KEY);
    expect(sealed).not.toContain("oura-access");
    expect(openOauth(sealed, KEY)).toEqual(TOKENS);
  });

  it("uses a fresh 12-byte IV, so the same input seals differently each time", () => {
    expect(sealOauth(TOKENS, KEY)).not.toBe(sealOauth(TOKENS, KEY));
    expect(Buffer.from(sealOauth(TOKENS, KEY), "base64").length)
      .toBe(12 + 16 + Buffer.byteLength(JSON.stringify(TOKENS), "utf8"));
  });

  it("throws on a tampered ciphertext and on the wrong key", () => {
    const bytes = Buffer.from(sealOauth(TOKENS, KEY), "base64");
    bytes[20] ^= 0xff;
    expect(() => openOauth(bytes.toString("base64"), KEY)).toThrow();
    expect(() => openOauth(sealOauth(TOKENS, KEY), randomBytes(32))).toThrow();
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => sealOauth(TOKENS, randomBytes(16))).toThrow(/32 bytes/);
  });
});
