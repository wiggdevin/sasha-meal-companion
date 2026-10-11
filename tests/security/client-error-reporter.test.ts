// @vitest-environment jsdom
/**
 * The phone's crash reporter (audit 2026-10-08 §5, W053): a report holds allowlisted values only —
 * an error code, an error name, a route pattern, a Next digest hash and the build. No free text
 * (message, path, query) ever leaves the phone. Deduped and capped per page load, no account or
 * session in the request, and the window hooks installed once.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ERROR_CODES, CLIENT_ERROR_NAMES, CLIENT_ERROR_ROUTES, classifyError, cleanReport, routePattern,
} from "@/lib/client-errors";
import {
  buildReport, installClientErrorHandlers, MAX_REPORTS_PER_LOAD, reportClientError,
  resetClientErrorReporterForTests,
} from "@/lib/client-error-reporter";
import { bindAccount, unbindAccount } from "@/lib/device/account";

let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetClientErrorReporterForTests();
  send = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", send);
  window.history.replaceState(null, "", "/foods?q=sasha@example.com#top");
});
afterEach(() => { resetClientErrorReporterForTests(); vi.unstubAllGlobals(); unbindAccount(); });

function bodies(): Record<string, unknown>[] {
  return send.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

const REPORT_KEYS = ["at", "build", "code", "digest", "name", "route", "source"];

describe("allowlists", () => {
  it("maps an error to a fixed code from its name and message; the message itself is never kept", () => {
    expect(classifyError("ChunkLoadError", "Loading chunk 12 failed.")).toBe("chunk_load");
    expect(classifyError("TypeError", "Failed to fetch dynamically imported module: /x.js")).toBe("chunk_load");
    expect(classifyError("Error", "Hydration failed because the server rendered HTML didn't match"))
      .toBe("hydration");
    expect(classifyError("TypeError", "Failed to fetch")).toBe("network");
    expect(classifyError("TypeError", "Load failed")).toBe("network");
    expect(classifyError("QuotaExceededError", "anything")).toBe("quota");
    expect(classifyError("AbortError", "The user aborted a request.")).toBe("abort");
    expect(classifyError("TypeError", "Cannot read properties of undefined (reading 'kcal')"))
      .toBe("undefined_value");
    expect(classifyError("TypeError", "undefined is not an object (evaluating 'a.b')")).toBe("undefined_value");
    expect(classifyError("TypeError", "x.map is not a function")).toBe("not_a_function");
    expect(classifyError("ReferenceError", "foo is not defined")).toBe("not_defined");
    expect(classifyError("Error", "Maximum update depth exceeded.")).toBe("render_loop");
    expect(classifyError("Error", "Bad kcal for sasha@example.com: 1800")).toBe("unknown");
    for (const code of ["chunk_load", "unknown", "non_error"]) expect(CLIENT_ERROR_CODES).toContain(code);
  });

  it("maps any location to a route pattern, never the path itself", () => {
    expect(routePattern("https://x.test/foods?tab=eats#h")).toBe("/foods");
    expect(routePattern("/coach/")).toBe("/coach");
    expect(routePattern("/")).toBe("/");
    expect(routePattern("/design/well")).toBe("/design/:page");
    expect(routePattern("/day/2026-10-08")).toBe("other");
    expect(routePattern("/sasha@example.com")).toBe("other");
    expect(routePattern("/foods/extra")).toBe("other");
    expect(routePattern("not a url \u0000")).toBe("other");
  });

  it("knows every page the app has (a new page needs a pattern, or its crashes read as other)", () => {
    const appDir = join(process.cwd(), "app");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry === "page.tsx") pages.push(`/${relative(appDir, dir).split(sep).join("/")}`.replace(/\/$/, ""));
      }
    };
    walk(appDir);
    expect(pages.length).toBeGreaterThan(5);
    for (const raw of pages) {
      const page = raw || "/";
      expect(routePattern(page), page).toBe(page.startsWith("/design/") ? "/design/:page" : page);
    }
    expect(CLIENT_ERROR_ROUTES).toContain("/design/:page");
  });

  it("keeps only allowlisted values; anything else becomes the fixed fallback", () => {
    const report = cleanReport({ name: "sasha@example.com", code: "free text 172 lb", digest: "<script>",
      build: "a b", source: "elsewhere", route: "/day/2026-10-08", at: "never", message: "secret",
      stack: "secret", userId: "u1" }, new Date("2026-10-08T00:00:00Z"));
    expect(report).toEqual({ source: "boundary", name: "Other", code: "unknown", digest: null, route: "other",
      build: null, at: "2026-10-08T00:00:00.000Z" });
    expect(CLIENT_ERROR_NAMES).toContain("TypeError");
  });

  it("keeps a Next digest only in Next's own form (a decimal hash, optionally @E<code>)", () => {
    const at = new Date("2026-10-08T00:00:00Z");
    expect(cleanReport({ digest: "2349871234" }, at).digest).toBe("2349871234");
    expect(cleanReport({ digest: "2349871234@E394" }, at).digest).toBe("2349871234@E394");
    for (const digest of ["sashaexamplecom", "12ab", "1".repeat(40), "NEXT_REDIRECT;replace;/x"])
      expect(cleanReport({ digest }, at).digest).toBeNull();
  });
});

describe("reportClientError", () => {
  it("posts one allowlisted report with no account header, no credentials, no message and no stack", () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const error = Object.assign(new TypeError("Bad kcal for sasha@example.com: 1800 lb"), { digest: "77" });
    expect(reportClientError(error)).toBe(true);
    const [url, init] = send.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/client-errors");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("x-smc-account")).toBeNull();
    const body = bodies()[0];
    expect(Object.keys(body).sort()).toEqual(REPORT_KEYS);
    expect(body).toMatchObject({ source: "boundary", name: "TypeError", code: "unknown", digest: "77",
      route: "/foods" });
    const text = String(init.body);
    for (const leak of ["sasha", "example.com", "1800", "kcal", "11111111", "stack", "?q", "#top"])
      expect(text).not.toContain(leak);
  });

  it("sends the same (source, name, code, route) once per page load", () => {
    reportClientError(new Error("same"));
    reportClientError(new Error("different text, same code"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_REPORTS_PER_LOAD} reports in one page load`, () => {
    const names = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AbortError"];
    for (const name of names) reportClientError(Object.assign(new Error("x"), { name }));
    expect(send).toHaveBeenCalledTimes(MAX_REPORTS_PER_LOAD);
  });

  it("never throws, even when fetch itself throws or rejects", () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no network"); }));
    expect(() => reportClientError(new Error("a"))).not.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(() => reportClientError(new TypeError("b"))).not.toThrow();
  });

  it("describes a thrown non-error without its contents", () => {
    const report = buildReport({ secret: "value" }, "unhandled-rejection");
    expect(report).toMatchObject({ name: "Other", code: "non_error" });
    expect(JSON.stringify(report)).not.toContain("value");
  });
});

describe("installClientErrorHandlers", () => {
  it("reports uncaught errors and unhandled rejections, and installs once", () => {
    installClientErrorHandlers();
    installClientErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("loop"), message: "loop" }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new TypeError("Failed to fetch");
    window.dispatchEvent(rejection);
    expect(bodies().map((b) => [b.source, b.name, b.code])).toEqual([
      ["window-error", "RangeError", "unknown"], ["unhandled-rejection", "TypeError", "network"],
    ]);
  });

  it("ignores a resource load error (no error value, no message)", () => {
    installClientErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error"));
    expect(send).not.toHaveBeenCalled();
  });
});
