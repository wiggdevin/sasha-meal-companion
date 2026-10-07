// tests/sync/cross-user-http.test.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as getChanges } from "../../app/api/sync/changes/route";
import { POST as postOps } from "../../app/api/sync/ops/route";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import type { SyncOp } from "@/lib/sync/types";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

const run = HAS_BRANCH ? describe : describe.skip;
const A_WATER_DATE = "2026-09-11";

/** Phase 9 §0.5: ops name their owner. `owner` undefined is an old build's op. */
function updateOp(owner?: string): SyncOp & { user_id?: string } {
  return {
    ...(owner === undefined ? {} : { user_id: owner }),
    op_id: crypto.randomUUID(), entity: "water_log", entity_id: A_WATER_DATE, kind: "update",
    base_rev: 1, payload: { local_date: A_WATER_DATE, cups: 9 },
    client_ts: new Date().toISOString(),
  };
}

/** Sign in as `client` on a seed Request, then render the session as a `Cookie:` header string —
 *  requireUser reads the session from the Cookie header only (@supabase/ssr createServerClient
 *  with cookies.getAll from `req.headers.get('cookie')`); a Bearer header is ignored. */
async function cookieHeaderFor(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  const session = data.session!;
  const seed = new Request("https://app.test/seed");
  await createRequestClient(seed).auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return cookieJar(seed).map((c) => c.name + "=" + encodeURIComponent(c.value)).join("; ");
}

function opsRequest(ops: (SyncOp & { user_id?: string })[], cookie?: string): Request {
  return new Request("https://app.test/api/sync/ops", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {}),
    },
    body: JSON.stringify({ ops }),
  });
}

function changesRequest(cookie?: string): Request {
  return new Request("https://app.test/api/sync/changes?since=0", {
    headers: cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {},
  });
}

run("sync routes cross-user denial", () => {
  let bCookie = "";
  let a: { client: SupabaseClient; userId: string };
  let bUserId = "";
  let admin: SupabaseClient;

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;

    const users = await createTestUsers();
    a = users.a;
    admin = users.admin;

    // A real water_log row for user A, created through apply_sync_op (not a raw insert) so it
    // also lands in change_log — otherwise sync_changes has nothing to (not) return.
    const created = await admin.rpc("apply_sync_op", {
      p_user_id: a.userId,
      p_op: {
        op_id: crypto.randomUUID(), entity: "water_log", entity_id: A_WATER_DATE, kind: "create",
        base_rev: null, payload: { local_date: A_WATER_DATE, cups: 3 },
        client_ts: new Date().toISOString(),
      },
    });
    expect(created.error).toBeNull();

    bCookie = await cookieHeaderFor(users.b.client);
    bUserId = users.b.userId;
  });

  it("401s both routes with no session", async () => {
    const opsRes = await postOps(opsRequest([updateOp(a.userId)]));
    expect(opsRes.status).toBe(401);
    expect((await getChanges(changesRequest())).status).toBe(401);
  });

  async function aCups(): Promise<number | undefined> {
    const row = await admin.from("water_log").select("cups")
      .eq("user_id", a.userId).eq("local_date", A_WATER_DATE).single();
    return row.data?.cups;
  }

  it("refuses an op stamped for A under B's cookie with account_mismatch, A's row unchanged", async () => {
    const res = await postOps(opsRequest([updateOp(a.userId)], bCookie));
    expect((await res.json()).results).toMatchObject([{ status: "error", message: "account_mismatch" }]);
    expect(await aCups()).toBe(3);
  });

  it("refuses an ownerless op (an old tab) under B's cookie with account_unbound, no row changed", async () => {
    const res = await postOps(opsRequest([updateOp()], bCookie));
    expect((await res.json()).results).toMatchObject([{ status: "error", message: "account_unbound" }]);
    expect(await aCups()).toBe(3);
    const bRow = await admin.from("water_log").select("cups")
      .eq("user_id", bUserId).eq("local_date", A_WATER_DATE).maybeSingle();
    expect(bRow.data).toBeNull();
  });

  it("user B's op against user A's entity key comes back 'gone', with zero effect", async () => {
    const res = await postOps(opsRequest([updateOp(bUserId)], bCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    // 'gone': water_log is keyed by (user_id, local_date), so B's own table has no such row —
    // apply_sync_op never reaches, let alone touches, A's row.
    expect(body.results).toMatchObject([{ status: "gone" }]);

    const row = await admin
      .from("water_log")
      .select("cups")
      .eq("user_id", a.userId)
      .eq("local_date", A_WATER_DATE)
      .single();
    expect(row.data?.cups).toBe(3);
  });

  it("user B's GET /api/sync/changes returns none of user A's rows", async () => {
    // A's own feed must carry the row, or B's empty result proves nothing.
    const aFeed = await admin.rpc("sync_changes", { p_user_id: a.userId, p_since: 0, p_limit: 500 });
    expect(aFeed.error).toBeNull();
    const aChanges = (aFeed.data ?? []) as { entity_key: string }[];
    expect(aChanges.some((c) => c.entity_key === A_WATER_DATE)).toBe(true);

    const body = await (await getChanges(changesRequest(bCookie))).json();
    const aRow = body.changes.find(
      (c: { entity_key: string }) => c.entity_key === A_WATER_DATE,
    );
    expect(aRow).toBeUndefined();
  });
});
