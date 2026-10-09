// @vitest-environment jsdom
/**
 * The phone's crash reporter (audit 2026-10-08 §5): scrubbed reports, deduped and capped per page
 * load, no account or session in the request, and the window hooks installed once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanReport, scrubRoute, scrubText } from "@/lib/client-errors";
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
  window.history.replaceState(null, "", "/foods/2026-10-08?q=sasha@example.com#top");
});
afterEach(() => { resetClientErrorReporterForTests(); vi.unstubAllGlobals(); unbindAccount(); });

function bodies(): Record<string, unknown>[] {
  return send.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

describe("scrubbing", () => {
  it("replaces emails and digits, flattens newlines and cuts to 300 characters", () => {
    expect(scrubText("mail sasha.k+1@example.co.uk now")).toBe("mail [email] now");
    expect(scrubText("weight 172.4 on 10/08")).toBe("weight ###.# on ##/##");
    expect(scrubText("a\nb\tc")).toBe("a b c");
    expect(scrubText("z".repeat(1000))).toHaveLength(300);
  });

  it("keeps only the path of a route, without origin, query or hash", () => {
    expect(scrubRoute("https://x.test/day/2026-10-08?u=1#h")).toBe("/day/####-##-##");
    expect(scrubRoute("/coach?thread=abc")).toBe("/coach");
  });

  it("keeps only the report's own fields and bounds each one", () => {
    const report = cleanReport({ name: "not a name!", message: 42, digest: "<script>", build: "a b",
      source: "elsewhere", route: 7, at: "never", stack: "secret", userId: "u1" },
    new Date("2026-10-08T00:00:00Z"));
    expect(report).toEqual({ source: "boundary", name: "Error", message: "", digest: null, route: "/",
      build: null, at: "2026-10-08T00:00:00.000Z" });
  });
});

describe("reportClientError", () => {
  it("posts one minimal report with no account header, no credentials and no stack", () => {
    bindAccount("11111111-1111-4111-8111-111111111111");
    const error = Object.assign(new TypeError("Bad kcal for sasha@example.com: 1800"), { digest: "d1" });
    expect(reportClientError(error)).toBe(true);
    const [url, init] = send.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/client-errors");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("x-smc-account")).toBeNull();
    const body = bodies()[0];
    expect(body).toMatchObject({ source: "boundary", name: "TypeError",
      message: "Bad kcal for [email]: ####", digest: "d1", route: "/foods/####-##-##" });
    const text = String(init.body);
    for (const leak of ["sasha@example.com", "1800", "11111111", "stack"]) expect(text).not.toContain(leak);
  });

  it("sends the same error once per page load", () => {
    reportClientError(new Error("same"));
    reportClientError(new Error("same"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_REPORTS_PER_LOAD} reports in one page load`, () => {
    for (let i = 0; i < 20; i += 1) reportClientError(new Error(`distinct ${String.fromCharCode(97 + i)}`));
    expect(send).toHaveBeenCalledTimes(MAX_REPORTS_PER_LOAD);
  });

  it("never throws, even when fetch itself throws or rejects", () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no network"); }));
    expect(() => reportClientError(new Error("a"))).not.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(() => reportClientError(new Error("b"))).not.toThrow();
  });

  it("describes a thrown non-error without its contents", () => {
    expect(buildReport({ secret: "value" }, "unhandled-rejection").message).toBe("Non-error value thrown");
  });
});

describe("installClientErrorHandlers", () => {
  it("reports uncaught errors and unhandled rejections, and installs once", () => {
    installClientErrorHandlers();
    installClientErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error", { error: new RangeError("loop"), message: "loop" }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("rejected");
    window.dispatchEvent(rejection);
    expect(bodies().map((b) => [b.source, b.name, b.message])).toEqual([
      ["window-error", "RangeError", "loop"], ["unhandled-rejection", "Error", "rejected"],
    ]);
  });

  it("ignores a resource load error (no error value, no message)", () => {
    installClientErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error"));
    expect(send).not.toHaveBeenCalled();
  });
});
