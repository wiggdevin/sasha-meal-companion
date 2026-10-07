/**
 * Vercel's edge network sets `x-real-ip` to the address it actually accepted
 * the connection from and overwrites any client-supplied value, so it can be
 * trusted. `x-forwarded-for` cannot: a caller can set it to anything, so
 * keying the limiter on it lets an attacker rotate past `enforceRateLimit`
 * entirely (see app/auth/callback/route.ts, which already keys this way).
 */
export function rateLimitKey(req: Request, scope = "log:propose"): string {
  const ip = req.headers.get("x-real-ip") ?? "unknown";
  // Scale S2: each route has its own scope. Propose, inspire and document used to share the one
  // `log:propose:ip:` bucket, so a burst on one spent the others' limits.
  return `${scope}:ip:${ip}`;
}

