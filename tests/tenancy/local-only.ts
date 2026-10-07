/**
 * The shared local-only guard for every tenancy suite that can reach a database (review r7/r8).
 * Import it first (`import "./local-only";`); tests/tenancy/local-only-imports.test.ts enforces
 * that. It runs when the module loads, before any other module or suite does work (some suites
 * read pg_catalog while being collected), and before any setup or write:
 *
 * - no test database configured (the Quality job, a plain `vitest run`): nothing to guard, the
 *   suites skip themselves;
 * - any test database configured: the test API, the test database and the app's admin URL must all
 *   be loopback hosts, or the whole file fails before it can touch anything.
 */
import { assertLocalTargets } from "./target-guard";

export function guardLocalOnly(env: Record<string, string | undefined> = process.env): void {
  const configured = [env.SUPABASE_TEST_URL, env.SUPABASE_TEST_DB_URL, env.SUPABASE_TEST_ANON_KEY,
    env.SUPABASE_TEST_SERVICE_ROLE_KEY].some((v) => (v ?? "").length > 0);
  if (configured) assertLocalTargets(env);
}

guardLocalOnly();
