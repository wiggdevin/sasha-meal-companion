import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, accountBlob, accountFetch, accountJson, accountText, bindAccount, unbindAccount,
} from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Files that may call fetch on an /api/ route directly: the helper itself, the deadline race it
 *  wraps, and the warm ping (no user data in the request or the answer).
 *
 *  round 10 finding #5: lib/foods/label-check-client.ts used to be listed here too, for an
 *  explicit `userId` override (documented since c087765) that let it act for an account other
 *  than the one bound on this device. That override is deleted — Phase 9 §0.5a is binding, a
 *  client acts only for the bound account — so the file now goes through `accountFetch` like
 *  every other one, and this is exactly the gate that would have caught it if it had not.
 *
 *  lib/client-error-reporter.ts (audit 2026-10-08 §5) posts an allowlisted crash report that names no
 *  account, like the warm ping: a crash during sign-in or an account switch must still be heard. */
const ALLOWED = new Set([
  "lib/device/account.ts", "lib/warm-client.ts", "lib/fetch-with-deadline.ts", "lib/client-error-reporter.ts",
  // W052: the sign-in screen's calls run before any account exists on the device, so there is no
  // bound account to name; the answer only sets the session cookie.
  "lib/sign-in-client.ts",
]);
const HREF_API = /href=\{?["'`]?[^}"'`]*\/api\//;
const RAW_BODY = /\.(json|text|blob)\(\)/;
const RAW_CALL = /\b(fetch|fetchWithDeadline|fetchFn|fetchImpl|doFetch|send|globalThis\.fetch)\s*\(/;
const API_LITERAL = /["'`]\/api\//;
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;

beforeEach(() => { unbindAccount(); });

describe("accountFetch (Phase 9 §0.5a)", () => {
  it("bounds a stalled 409 body by what is left of the caller's budget (review t4r8 #4)", async () => {
    const { DEADLINES, DeadlineExceeded } = await import("@/lib/fetch-with-deadline");
    const saved = DEADLINES.undo;
    DEADLINES.undo = 40;
    try {
      const stalled = new ReadableStream({ start() { /* never enqueues, never closes */ } });
      const f = vi.fn(async () => new Response(stalled, { status: 409 }));
      const started = Date.now();
      await expect(accountFetch(bindAccount(A), "/api/x", {}, { fetchImpl: f as never, budget: "undo" }))
        .rejects.toBeInstanceOf(DeadlineExceeded);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally { DEADLINES.undo = saved; }
  });

  it("adds x-smc-account and keeps the caller's headers", async () => {
    const f = vi.fn(async () => new Response("{}"));
    await accountFetch(bindAccount(A), "/api/x", { headers: { accept: "application/json" } },
      { fetchImpl: f as never });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = new Headers(init.headers);
    expect(headers.get("x-smc-account")).toBe(A);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("drops a response that arrives after the account changed", async () => {
    let answer!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = accountFetch(a, "/api/coach/turn", {}, { fetchImpl: f as never });
    bindAccount(B);
    answer(new Response(JSON.stringify({ reply: "A only" })));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
  });

  it("drops a body parsed after the account changed", async () => {
    const a = bindAccount(A);
    const ok = (body: string) => accountFetch(a, "/api/x", {},
      { fetchImpl: (async () => new Response(body)) as never });
    const r1 = await ok("{\"x\":1}");
    const r2 = await ok("t");
    const r3 = await ok("b");
    await expect(accountJson(a, r1)).resolves.toEqual({ x: 1 });
    bindAccount(B);
    await expect(accountText(a, r2)).rejects.toBeInstanceOf(AccountChanged);
    await expect(accountBlob(a, r3)).rejects.toBeInstanceOf(AccountChanged);
  });

  it("treats the server's 409 account_mismatch as AccountChanged, so no caller reads it as a refusal", async () => {
    const f = vi.fn(async () => Response.json(
      { error: "account_mismatch", message: "This request belongs to another account on this device." },
      { status: 409 }));
    await expect(accountFetch(bindAccount(A), "/api/log/commit", {}, { fetchImpl: f as never }))
      .rejects.toBeInstanceOf(AccountChanged);
  });

  it("passes any other 409 through untouched", async () => {
    const f = vi.fn(async () => Response.json({ status: "conflict" }, { status: 409 }));
    const res = await accountFetch(bindAccount(A), "/api/x", {}, { fetchImpl: f as never });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ status: "conflict" });
  });

  it("sends nothing with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    const f = vi.fn();
    await expect(accountFetch(a, "/api/x", {}, { fetchImpl: f as never }))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(f).not.toHaveBeenCalled();
  });

  it("is the only way client code calls an app /api/ route", () => {
    const offenders: string[] = [];
    const files = ["lib", "components", "app"].flatMap((d) =>
      (readdirSync(d, { recursive: true }) as string[]).map((f) => `${d}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f));
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (API_LITERAL.test(src) && RAW_CALL.test(src)) offenders.push(file);
      if (HREF_API.test(src) || /href=\{exportHref/.test(src)) offenders.push(`${file} (href)`);
      if (/accountFetch\(/.test(src) && RAW_BODY.test(src)) offenders.push(`${file} (raw body)`);
      if (/location\.(assign|replace|href)\s*[=(]\s*["'`]\/api\//.test(src)) {
        offenders.push(`${file} (navigation to /api/)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
