import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { readFreshness } from "./lib/dev/freshness";
import { securityHeaderRules } from "./lib/security-headers";

// Dev only: how far this checkout is behind main, for the old-code banner (lib/dev/freshness.ts).
const devFreshness = process.env.NODE_ENV === "production" ? null
  : readFreshness((args) => execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_DEV_FRESHNESS: JSON.stringify(devFreshness),
    // The commit a crash report came from (lib/client-error-reporter.ts): a stale installed PWA
    // can run an older build than the server's.
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
  // Keep the development toolbar away from the phone dock and the header avatar (top-right).
  devIndicators: { position: "top-left" },
  // Snapshot v3 (Phase 18 W8) reads the W1b artifacts and the NCHS ruling from disk at run time
  // (lib/foods/universe/artifacts.ts): without them in the bundle the prior reads as neutral.
  outputFileTracingIncludes: {
    "/api/foods/eligible": ["./lib/foods/universe/artifacts/**", "./docs/decisions/2026-10-05-nhanes-aggregate-use.md"],
  },
  // /scan lives inside the coach now. A config redirect runs before the auth middleware, so a
  // deep link or QR code lands in the chat after sign-in instead of on a retired page.
  // Security response headers on every route, /api/*, the manifest and sw.js included
  // (lib/security-headers.ts; audit 2026-10-08 §5).
  async headers() {
    return securityHeaderRules();
  },
  async redirects() {
    return [{ source: "/scan", destination: "/coach?open=scan", permanent: false }];
  },
};

export default nextConfig;
