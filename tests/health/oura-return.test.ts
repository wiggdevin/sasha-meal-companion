import { describe, expect, it } from "vitest";
import { oauthReturnTo, safeReturnTo } from "@/lib/health/oura-return";

const ORIGIN = "https://app.test";

describe("Oura return path", () => {
  it("keeps relative and absolute same-origin paths, including a query", () => {
    expect(safeReturnTo("/body?tab=sleep", ORIGIN)).toBe("/body?tab=sleep");
    expect(safeReturnTo("https://app.test/foods#recipes", ORIGIN)).toBe("/foods#recipes");
  });

  it.each(["//evil.test/path", "https://evil.test/path", "javascript:alert(1)",
    "/\\evil.test", "/body\nLocation: https://evil.test", ""])(
    "rejects unsafe destination %s", (value) => {
      expect(safeReturnTo(value, ORIGIN)).toBeNull();
    });

  it("reads a return path from OAuth state and defaults safely", () => {
    const encoded = Buffer.from("/body?tab=sleep").toString("base64url");
    expect(oauthReturnTo(`nonce.${encoded}`, ORIGIN)).toBe("/body?tab=sleep");
    expect(oauthReturnTo("nonce.aHR0cHM6Ly9ldmlsLnRlc3Q", ORIGIN)).toBe("/settings");
    expect(oauthReturnTo(null, ORIGIN)).toBe("/settings");
  });
});
