/**
 * The caller's IP for a per-IP rate-limit key (scale S2). Only `x-real-ip` is trusted: Vercel
 * sets it to the address it accepted the connection from and overwrites any client value. A
 * caller can set `x-forwarded-for` to anything on any other host, so it is never read; without
 * `x-real-ip` every such caller shares the "unknown" bucket.
 * Its own module so a test that mocks lib/server/ratelimit still gets the real helper.
 */
export function requestIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  return real && real.length > 0 ? real : "unknown";
}
