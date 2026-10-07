import { describe, expect, it } from "vitest";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

const SUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const jwt = `${b64url("{}")}.${b64url(JSON.stringify({ sub: SUB }))}.sig`;
const session = JSON.stringify({ access_token: jwt, refresh_token: "r" });

describe("accountHeaderFromCookie", () => {
  it("reads the user from a base64 auth cookie", () => {
    const cookie = `sb-x-auth-token=${encodeURIComponent(`base64-${b64url(session)}`)}`;
    expect(accountHeaderFromCookie(cookie)).toEqual({ "x-smc-account": SUB });
  });

  it("joins a chunked cookie in chunk order", () => {
    const value = `base64-${b64url(session)}`;
    const cut = Math.floor(value.length / 2);
    const cookie = `sb-x-auth-token.1=${encodeURIComponent(value.slice(cut))}; `
      + `sb-x-auth-token.0=${encodeURIComponent(value.slice(0, cut))}`;
    expect(accountHeaderFromCookie(cookie)).toEqual({ "x-smc-account": SUB });
  });

  it("reads a plain JSON cookie, and gives no header without a cookie", () => {
    expect(accountHeaderFromCookie(`sb-x-auth-token=${encodeURIComponent(session)}`))
      .toEqual({ "x-smc-account": SUB });
    expect(accountHeaderFromCookie(undefined)).toEqual({});
  });
});
