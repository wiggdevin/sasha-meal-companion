/**
 * The ONLY module that reads SUPABASE_SERVICE_ROLE_KEY (architecture.md §2.2
 * rule 4, spec acceptance criterion 6). Used by the privileged boundary, the
 * import worker and cron jobs — nothing else.
 *
 * The client is cached because it holds no per-request identity: it is the
 * single documented exception to "no module-level Supabase client".
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("lib/server/admin.ts is server-only and must never reach the browser bundle.");
  }
  if (cached) return cached;
  // Branch runs (`scripts/db-branch.sh env`) export TEST-prefixed names; production sets the
  // primary names, so the fallback only ever applies where the primary is absent.
  const url = process.env.SUPABASE_URL ?? process.env.SUPABASE_TEST_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Client for command-line tools (facet warming, import annotation). Branch-first: when the
 * TEST-prefixed names from `scripts/db-branch.sh env` are present they win, whatever else the
 * shell carries. A non-TEST (production) target is refused unless the caller passes
 * `production: true` (an explicit `--production` flag). Not cached; logs the target host only.
 */
export function adminClientForCli(opts: { production?: boolean } = {}): SupabaseClient {
  const testUrl = process.env.SUPABASE_TEST_URL;
  const testKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  if (testUrl && testKey) {
    console.log(`target: branch ${new URL(testUrl).host}`);
    return createClient(testUrl, testKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("no Supabase target: export the branch TEST names, or the production names with --production");
  }
  if (!opts.production) {
    throw new Error(`refusing to target ${new URL(url).host} without --production (no branch TEST target in the environment)`);
  }
  console.log(`target: production ${new URL(url).host}`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A reviewed seed target has already passed its origin and production-ref confirmation.
 * Resolve its credential here so the seed CLI never reads or carries a service key. */
export function adminClientForSeedTarget(
  target: { url: string; mode: "local" | "production" },
  env: Record<string, string | undefined>,
): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("Seed admin clients are server-only.");
  }
  const configuredUrl = target.mode === "production" ? env.SUPABASE_URL : env.SUPABASE_TEST_URL;
  const key = target.mode === "production"
    ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  if (!configuredUrl || !key) throw new Error(`${target.mode} Supabase URL or service key is missing`);
  if (new URL(configuredUrl).origin !== target.url) {
    throw new Error("Seed target changed after confirmation");
  }
  return createClient(target.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
