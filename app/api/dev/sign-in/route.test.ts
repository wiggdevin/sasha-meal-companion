import { describe, expect, it } from "vitest";
import { devSignInAllowed } from "@/lib/server/dev-sign-in";

describe("devSignInAllowed", () => {
  const dev = { NODE_ENV: "development", DEV_SIGN_IN_EMAIL: "someone@example.com" };

  it("allows a local dev server with an email configured", () => {
    expect(devSignInAllowed(dev)).toBe(true);
  });

  it("refuses in production", () => {
    expect(devSignInAllowed({ ...dev, NODE_ENV: "production" })).toBe(false);
  });

  it("refuses on any Vercel environment, even a preview", () => {
    expect(devSignInAllowed({ ...dev, VERCEL: "1" })).toBe(false);
    expect(devSignInAllowed({ ...dev, VERCEL_ENV: "preview" })).toBe(false);
  });

  it("refuses when no email is configured", () => {
    expect(devSignInAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(devSignInAllowed({ NODE_ENV: "development", DEV_SIGN_IN_EMAIL: "" })).toBe(false);
  });
});
