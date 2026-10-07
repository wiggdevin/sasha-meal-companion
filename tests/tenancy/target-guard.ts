/**
 * The local-only boundary for the admin-client canaries (review r6 finding 2, r7 finding 1).
 * They run real server code and cron jobs, and some of those act on every account (the jobs list
 * all users; the media sweep deletes expired objects of any account). So they may run only against
 * a disposable local Supabase stack: the test API, the test database, and the URL the app's own
 * admin client resolves to (`SUPABASE_URL ?? SUPABASE_TEST_URL`, lib/server/admin.ts) must all be
 * loopback hosts. Two equal hosted URLs are refused like any other hosted URL. CI's integration job
 * starts that local stack on 127.0.0.1 (scripts/ci-local-supabase.py refuses anything else).
 */
type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** True only when the test API, the test database and the app's admin URL are all loopback. */
export function localTargets(env: Env = process.env): boolean {
  const appAdminUrl = env.SUPABASE_URL ?? env.SUPABASE_TEST_URL;
  return isLoopback(env.SUPABASE_TEST_URL) && isLoopback(env.SUPABASE_TEST_DB_URL)
    && isLoopback(appAdminUrl);
}

/** Throws before any setup unless every target is a local, disposable stack. */
export function assertLocalTargets(env: Env = process.env): void {
  if (!localTargets(env)) {
    throw new Error("tenancy suites run only against a local Supabase stack (loopback API, "
      + "database and SUPABASE_URL); refusing this target");
  }
}
