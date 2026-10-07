export function devSignInAllowed(env: Record<string, string | undefined> = process.env): boolean {
  // Explicit allowlist (PR #246 review r1, finding 2): only NODE_ENV === "development" is
  // allowed. "test", unset, and every other value are refused, not just "production" — a
  // narrower check that used to let a "test" or unset NODE_ENV through.
  if (env.NODE_ENV !== "development") return false;
  if (env.VERCEL || env.VERCEL_ENV) return false;
  return typeof env.DEV_SIGN_IN_EMAIL === "string" && env.DEV_SIGN_IN_EMAIL.includes("@");
}

