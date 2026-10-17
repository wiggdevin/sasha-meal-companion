/**
 * Spec 3.5 canary for `POST /api/account/delete` and `lib/server/account-delete.ts`, service-role
 * entry points: the route deletes the session's own account and nothing else. A throwaway account
 * X (never the shared users A and B, which other suites need) signs in, so its session's sign-in
 * is recent. B carries a canary row. Then:
 *
 * - X's session with B's account header is refused (409) and B is untouched;
 * - X's own delete answers `deleted`; X is gone and B's canary and auth user remain.
 *
 * The route runs against the local stack with the real admin client and the flag on.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import { adminClient, anonClient, ensureUser, HAS_BRANCH, HAS_DB, runSql, type TestUser } from "../helpers/supabase";
import { assertLocalTargets } from "./target-guard";

const { POST: deleteAccountRoute } = await import("@/app/api/account/delete/route");
const { deleteAccount } = await import("@/lib/server/account-delete");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

async function cookieHeaderFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const session = data.session!;
  const seed = new Request("https://app.test/seed");
  await createRequestClient(seed).auth.setSession({
    access_token: session.access_token, refresh_token: session.refresh_token,
  });
  return cookieJar(seed).map((c) => c.name + "=" + encodeURIComponent(c.value)).join("; ");
}

function post(cookie: string, account: Record<string, string>): Promise<Response> {
  return deleteAccountRoute(new Request("https://app.test/api/account/delete", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-real-ip": "10.0.0.9", ...account },
    body: JSON.stringify({ confirm: "DELETE" }),
  }));
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("account deletion (canary)", () => {
  let b: TestUser;
  let x = "";
  let cookie = "";
  const canary = `account-delete canary ${randomUUID()}`;
  const canaryCount = () =>
    runSql(`select count(*) from public.user_foods where user_id = '${b.id}' and name = '${canary}'`);

  beforeAll(async () => {
    assertLocalTargets();
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;
    b = await ensureUser("b");
    runSql(`insert into public.user_foods (user_id, name, kind) values ('${b.id}', '${canary}', 'custom')`);
    const email = `delete-canary-${randomUUID()}@meal-companion.test`;
    const password = randomUUID();
    const made = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
    if (made.error || !made.data.user) throw made.error ?? new Error("no user");
    x = made.data.user.id;
    const client = anonClient();
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    cookie = await cookieHeaderFor(client);
  });
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("ACCOUNT_DELETION_ENABLED", "1");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (HAS_DB) runSql(`delete from public.user_foods where user_id = '${b.id}' and name = '${canary}'`);
    if (x) await deleteAccount(adminClient(), x).catch(() => undefined);
  });

  it("refuses X's session that names B's account and leaves B whole", async () => {
    const res = await post(cookie, { "x-smc-account": b.id });
    expect(res.status).toBe(409);
    expect(canaryCount()).toBe("1");
    expect(runSql(`select count(*) from auth.users where id in ('${x}', '${b.id}')`)).toBe("2");
  });

  it("deletes X only and keeps B's canary", async () => {
    const res = await post(cookie, accountHeaderFromCookie(cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deleted" });
    expect(runSql(`select count(*) from auth.users where id = '${x}'`)).toBe("0");
    expect(runSql(`select count(*) from auth.users where id = '${b.id}'`)).toBe("1");
    expect(canaryCount()).toBe("1");
  });
});
