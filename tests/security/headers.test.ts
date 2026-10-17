/**
 * Security response headers (audit 2026-10-08 §5): next.config applies them to every route, and
 * they keep what the app needs on its own origin (camera, microphone, geolocation).
 */
import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
import middleware from "@/middleware";
import {
  CSP_ENFORCE, NONCE_HEADER, PAGE_CSP_HEADER, SECURITY_HEADERS, makeNonce, pagePolicy,
} from "@/lib/security-headers";

async function rules() {
  const { default: config } = await import("../../next.config");
  return (await config.headers?.()) ?? [];
}

function header(key: string): string | undefined {
  return SECURITY_HEADERS.find((row) => row.key === key)?.value;
}

it("applies the security headers to every path through next.config headers()", async () => {
  const all = await rules();
  const everywhere = all.find((rule) => rule.source === "/:path*");
  expect(everywhere?.headers).toEqual(SECURITY_HEADERS);
  // No other rule overrides a security header for a narrower path (last match would win).
  const keys = new Set(SECURITY_HEADERS.map((row) => row.key.toLowerCase()));
  for (const rule of all.filter((r) => r !== everywhere))
    for (const h of rule.headers) expect(keys.has(h.key.toLowerCase())).toBe(false);
});

it("sets each header to its reviewed value", () => {
  expect(header("X-Content-Type-Options")).toBe("nosniff");
  expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(header("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  expect(header("X-Frame-Options")).toBe("DENY");
  expect(header("Content-Security-Policy")).toBe("frame-ancestors 'none'");
});

it("never preloads HSTS: that is a one-way owner decision", () => {
  expect(header("Strict-Transport-Security")).not.toMatch(/preload/);
});

it("keeps camera, microphone and geolocation for the app's own origin only", () => {
  const policy = header("Permissions-Policy") ?? "";
  expect(policy).toContain("camera=(self)");
  expect(policy).toContain("microphone=(self)");
  expect(policy).toContain("geolocation=(self)");
  expect(policy).not.toMatch(/\*/);
});

it("keeps the static, enforced policy to frame-ancestors (scripts are the per-request policy's)", () => {
  expect(header("Content-Security-Policy")).not.toMatch(/script-src|default-src/);
});

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split("; ").map((d) => {
    const [name, ...values] = d.split(" ");
    return [name, values];
  }));
}

it("ships the page policy report-only until a phone walkthrough shows no reports (W079)", () => {
  expect(CSP_ENFORCE).toBe(false);
  expect(PAGE_CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
});

it("allows scripts by nonce only, with no unsafe-inline and no eval outside development", () => {
  const prod = directives(pagePolicy("abc"));
  expect(prod.get("script-src")).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'", "'wasm-unsafe-eval'"]);
  expect(prod.get("object-src")).toEqual(["'none'"]);
  expect(prod.get("base-uri")).toEqual(["'self'"]);
  expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
  expect(pagePolicy("abc", { dev: true })).toContain("'unsafe-eval'");
});

it("lets the browser reach Supabase (https and realtime) and nothing else off-origin", () => {
  const p = directives(pagePolicy("n", { supabaseUrl: "https://abc.supabase.co/" }));
  expect(p.get("connect-src")).toEqual(["'self'", "https://abc.supabase.co", "wss://abc.supabase.co"]);
  expect(p.get("img-src")).toContain("https://abc.supabase.co");
  for (const values of p.values()) expect(values).not.toContain("*");
  expect(directives(pagePolicy("n", { supabaseUrl: "not a url" })).get("connect-src")).toEqual(["'self'"]);
});

it("makes a fresh 128-bit nonce each time", () => {
  const a = makeNonce();
  expect(atob(a)).toHaveLength(16);
  expect(makeNonce()).not.toBe(a);
});

it("sends the policy and its nonce on the request (where Next reads it) and on the response", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  try {
    for (const path of ["/sign-in", "/"]) {
      const res = await middleware(new NextRequest(`https://example.test${path}`));
      const policy = res.headers.get(PAGE_CSP_HEADER) ?? "";
      const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce).toBeTruthy();
      expect(res.headers.get(`x-middleware-request-${PAGE_CSP_HEADER.toLowerCase()}`)).toBe(policy);
      expect(res.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
