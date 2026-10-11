/**
 * Security response headers (audit 2026-10-08 §5): next.config applies them to every route, and
 * they keep what the app needs on its own origin (camera, microphone, geolocation).
 */
import { expect, it } from "vitest";
import { SECURITY_HEADERS } from "@/lib/security-headers";

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

it("carries no script-src policy yet (it would block Next's inline scripts without nonces)", () => {
  expect(header("Content-Security-Policy")).not.toMatch(/script-src|default-src/);
});
