/**
 * Where the browser lands after the Oura consent page. Only the app pages that start a connection
 * may be named (W025, audit A053): a free same-origin path was an open redirect, because a
 * dot-segment path such as `/.//evil.example` normalises to `//evil.example`, which the callback
 * then re-read as a protocol-relative URL on another host.
 */
export const OURA_RETURN_PATHS: readonly string[] = ["/", "/settings", "/onboarding", "/body", "/foods"];

const DEFAULT_RETURN = "/settings";

/** An allowlisted page of this app (with its own query and hash), or null. */
export function safeReturnTo(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !value || value.length > 512 ||
    /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("//")) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password) return null;
    if (!OURA_RETURN_PATHS.includes(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function oauthReturnTo(state: string | null, origin: string): string {
  const encoded = state?.split(".", 2)[1];
  if (!encoded || encoded.length > 700) return DEFAULT_RETURN;
  try {
    return safeReturnTo(Buffer.from(encoded, "base64url").toString("utf8"), origin) ?? DEFAULT_RETURN;
  } catch { return DEFAULT_RETURN; }
}

/**
 * The absolute redirect target for the callback, built so it can never leave `origin`: the path is
 * allowlisted first, and the final URL's origin is checked again before it is used.
 */
export function ouraReturnUrl(state: string | null, origin: string): URL {
  const url = new URL(oauthReturnTo(state, origin), origin);
  return url.origin === origin ? url : new URL(DEFAULT_RETURN, origin);
}
