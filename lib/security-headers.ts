/**
 * Security response headers for every route (audit 2026-10-08 §5, no-security-response-headers),
 * applied by `next.config.ts` `headers()` to pages, `/api/*`, the manifest and the service worker.
 *
 * The static `Content-Security-Policy` here is `frame-ancestors 'none'` only, enforced everywhere,
 * which pairs with X-Frame-Options for browsers that read one or the other. The full policy with a
 * per-request nonce `script-src` (W079) is `pagePolicy` below: `middleware.ts` sends it on every
 * page, report-only until `CSP_ENFORCE` is turned on (see that constant).
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

/**
 * W079: whether the nonce policy is enforced. Report-only first: the browser reports what the policy
 * would block (in the console) and blocks nothing, so the installed PWA, Supabase sign-in and sync,
 * the barcode worker and voice capture cannot break on a directive this file got wrong. Turn it on
 * once a signed-in walkthrough on a phone shows no reports.
 */
export const CSP_ENFORCE = false;

/** The header the page policy goes out under. Next reads a nonce from either one. */
export const PAGE_CSP_HEADER = CSP_ENFORCE ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

/** The request header middleware.ts hands the nonce to the root layout in. */
export const NONCE_HEADER = "x-nonce";

/** 128 random bits, base64. One per page request; never reused. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

/** The Supabase origin the browser talks to (auth, sync, storage), https and its realtime wss twin. */
function supabaseOrigins(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const { protocol, host } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return [];
    return [`${protocol}//${host}`, `${protocol === "https:" ? "wss" : "ws"}://${host}`];
  } catch {
    return [];
  }
}

/**
 * The page policy for one request. Scripts: Next's own scripts carry the nonce (it reads the nonce
 * from this header), and `'strict-dynamic'` lets them load their chunks and the barcode worker.
 * `'wasm-unsafe-eval'` is the barcode decoder; `'unsafe-eval'` is development only (React's dev
 * stacks). Styles stay `'unsafe-inline'`: the app's motion and layout write inline style attributes,
 * which a nonce cannot cover. Everything the browser fetches is this origin or Supabase; model calls
 * go through our own API routes.
 */
export function pagePolicy(nonce: string, opts: { dev?: boolean; supabaseUrl?: string } = {}): string {
  const supabase = supabaseOrigins(opts.supabaseUrl);
  const https = supabase.filter((o) => o.startsWith("http"));
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(opts.dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "blob:", "data:", ...https]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...supabase]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
