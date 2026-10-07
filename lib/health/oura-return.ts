/** Keep OAuth returns inside this app, including when a caller supplies an absolute URL. */
export function safeReturnTo(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || !value || value.length > 512 ||
    /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("//")) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/") || url.username || url.password)
      return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function oauthReturnTo(state: string | null, origin: string): string {
  const encoded = state?.split(".", 2)[1];
  if (!encoded || encoded.length > 700) return "/settings";
  try {
    return safeReturnTo(Buffer.from(encoded, "base64url").toString("utf8"), origin) ?? "/settings";
  } catch { return "/settings"; }
}
