import { describe, expect, it } from "vitest";
import { oauthReturnTo, ouraReturnUrl, safeReturnTo } from "@/lib/health/oura-return";

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

  it.each(["https://evil.example", "https://evil.example/settings", "/.//evil.example/p",
    "/./%2F/evil.example", "/admin", "/settings/../api/export", "/api/health/oura/start"])(
    "rejects a target that is not an allowlisted app page: %s", (value) => {
      expect(safeReturnTo(value, ORIGIN)).toBeNull();
    });

  it("keeps the allowlisted pages the app starts a connection from", () => {
    for (const path of ["/", "/settings", "/onboarding", "/body", "/foods"]) {
      expect(safeReturnTo(path, ORIGIN)).toBe(path);
    }
  });

  it("never builds a redirect off this origin, even from a crafted state", () => {
    for (const target of ["https://evil.example", "/.//evil.example/p", "//evil.example"]) {
      const state = `nonce.${Buffer.from(target).toString("base64url")}`;
      expect(ouraReturnUrl(state, ORIGIN).href).toBe("https://app.test/settings");
    }
  });

  it("reads a return path from OAuth state and defaults safely", () => {
    const encoded = Buffer.from("/body?tab=sleep").toString("base64url");
    expect(oauthReturnTo(`nonce.${encoded}`, ORIGIN)).toBe("/body?tab=sleep");
    expect(oauthReturnTo("nonce.aHR0cHM6Ly9ldmlsLnRlc3Q", ORIGIN)).toBe("/settings");
    expect(oauthReturnTo(null, ORIGIN)).toBe("/settings");
  });
});
