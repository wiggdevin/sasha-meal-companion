/**
 * PR #248 review r3 #1: account-data routes refuse a request with no `x-smc-account` header. The
 * branch tests build cookie-authenticated requests by hand; this reads the signed-in user from the
 * Supabase auth cookie (`sb-*-auth-token`, possibly chunked `.0`, `.1`, optionally `base64-`) and
 * returns the header the current client would send for that user. No cookie → no header.
 */
export function accountHeaderFromCookie(cookie?: string): Record<string, string> {
  if (!cookie) return {};
  const parts = cookie.split(/;\s*/).map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)) };
  }).filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
  if (parts.length === 0) return {};
  const chunk = (name: string) => Number(/\.(\d+)$/.exec(name)?.[1] ?? -1);
  let raw = parts.sort((a, b) => chunk(a.name) - chunk(b.name)).map((c) => c.value).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64").toString("utf8");
  const session = JSON.parse(raw) as { access_token?: string };
  const payload = session.access_token?.split(".")[1];
  if (!payload) return {};
  const sub = (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { sub?: string }).sub;
  return sub ? { "x-smc-account": sub } : {};
}
