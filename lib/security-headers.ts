/**
 * Security response headers for every route (audit 2026-10-08 §5, no-security-response-headers),
 * applied by `next.config.ts` `headers()` to pages, `/api/*`, the manifest and the service worker.
 *
 * Deliberately left out: a full `script-src` CSP. Next's inline bootstrap scripts and Vercel's
 * injected scripts need nonces or hashes first (follow-up). Only `frame-ancestors` is set here,
 * which pairs with X-Frame-Options for browsers that read one or the other.
 *
 * Permissions-Policy keeps what the app uses on its own origin: the camera (photo capture, barcode
 * scan), the microphone (voice capture, coach dictation) and geolocation (Shopping's "use my
 * location"). Nothing else and no third-party frame gets them.
 */
export type SecurityHeader = Readonly<{ key: string; value: string }>;

export const SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Two years, subdomains included; no `preload` (that is a one-way list submission for the owner).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self)" },
];

/** Every path, the root included (`/:path*` matches `/` too). */
export function securityHeaderRules(): { source: string; headers: SecurityHeader[] }[] {
  return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
}
