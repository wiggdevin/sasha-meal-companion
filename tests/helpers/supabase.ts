/**
 * Integration-test harness for the Phase 0 Supabase branch.
 *
 * Env (printed by `bash scripts/db-branch.sh env`):
 *   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
 * Every suite in tests/ skips itself when SUPABASE_TEST_URL is unset, so CI stays green
 * without a branch.
 *
 * `runSql` is the one thing PostgREST cannot do — apply a migration inside a transaction — and it
 * needs SUPABASE_TEST_DB_URL as well (`HAS_DB`). tests/catalog/helpers.ts uses the same psql call.
 */
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL ?? "";
const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const SECRET = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "";

export const HAS_BRANCH = URL.length > 0 && ANON.length > 0 && SECRET.length > 0;
export const HAS_DB = DB_URL.length > 0;

/**
 * The connection string, split into psql's PG* environment variables, so the password never
 * appears in a process argument list (`ps`, crash logs, CI step output). Only non-secret flags
 * go on argv.
 */
export function pgEnvFromUrl(url: string): Record<string, string> {
  const u = new globalThis.URL(url);
  return {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    ...(u.searchParams.get("sslmode") ? { PGSSLMODE: u.searchParams.get("sslmode") as string } : {}),
  };
}

/**
 * Runs SQL as the branch owner over psql and returns stdout, trimmed; throws on a SQL error.
 * Gated by SUPABASE_TEST_DB_URL, so a suite that needs it skips where CI has no branch.
 */
export function runSql(sql: string): string {
  if (!HAS_DB) throw new Error("runSql() needs SUPABASE_TEST_DB_URL");
  try {
    return execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-At", "-c", sql], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...pgEnvFromUrl(DB_URL) },
    }).trim();
  } catch (e) {
    throw new Error(`psql failed: ${String((e as { stderr?: Buffer | string }).stderr ?? "")}`);
  }
}

export type TestUser = { id: string; email: string; password: string };

const CREDENTIALS: Record<"a" | "b", { email: string; password: string }> = {
  a: { email: "p0-user-a@meal-companion.test", password: "p0-user-a-password-1" },
  b: { email: "p0-user-b@meal-companion.test", password: "p0-user-b-password-1" },
};

export function adminClient(): SupabaseClient {
  return createClient(URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function anonClient(): SupabaseClient {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function findByEmail(email: string): Promise<string | null> {
  const admin = adminClient();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

export async function ensureUser(slot: "a" | "b"): Promise<TestUser> {
  const { email, password } = CREDENTIALS[slot];
  const existing = await findByEmail(email);
  if (existing) return { id: existing, email, password };
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error(`could not create ${email}`);
  return { id: data.user.id, email, password };
}

export async function userClient(user: TestUser): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw error;
  return client;
}

export async function resetUser(userId: string): Promise<void> {
  const { error } = await adminClient().rpc("test_reset_user", { p_user_id: userId });
  if (error) throw error;
}

/**
 * Convenience wrapper for cross-user route tests (Lane C's
 * tests/sync/cross-user-http.test.ts, Lane D's tests/export/cross-user.test.ts): both users
 * signed in and ready to authorize a Request, plus the admin client for seeding rows.
 */
export async function createTestUsers(): Promise<{
  a: { client: SupabaseClient; userId: string };
  b: { client: SupabaseClient; userId: string };
  admin: SupabaseClient;
}> {
  const [userA, userB] = await Promise.all([ensureUser("a"), ensureUser("b")]);
  const [clientA, clientB] = await Promise.all([userClient(userA), userClient(userB)]);
  return {
    a: { client: clientA, userId: userA.id },
    b: { client: clientB, userId: userB.id },
    admin: adminClient(),
  };
}
