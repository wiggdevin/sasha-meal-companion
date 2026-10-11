// tests/sync/food-membership-ops-db.test.ts
// Production 2026-09-24 and 2026-09-27: a coach add_to_eats queued membership ops for names the
// account had never marked, and /api/sync/ops answered each with "malformed food membership
// result". set_food_membership had written the row, but its final SELECT shared one snapshot with
// the write and so returned NULL; for a known name it returned the previous status, which the
// route reported as `rejected`. The unit tests fake the RPC, so this runs against the real one.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postOps } from "../../app/api/sync/ops/route";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import type { SyncOp } from "@/lib/sync/types";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";

const run = HAS_BRANCH ? describe : describe.skip;

/** requireUser reads the session from the Cookie header only, as in cross-user-http.test.ts. */
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

run("food_membership ops against the real set_food_membership", () => {
  let cookie = "";
  let userId = "";
  let admin: SupabaseClient;
  const names: string[] = [];

  /** A name this account has never marked, so the first op is the first write for it. */
  function freshName(): string {
    const name = `membership result ${crypto.randomUUID()}`;
    names.push(name);
    return name;
  }

  function op(name: string, status: "eats" | "avoid" | null, rev: number):
    SyncOp & { user_id: string } {
    const id = crypto.randomUUID();
    return {
      user_id: userId, op_id: crypto.randomUUID(), entity: "food_membership", entity_id: id,
      kind: "update", base_rev: null, payload: { id, name_norm: name, status, note: null, rev },
      client_ts: new Date().toISOString(),
    };
  }

  async function send(o: SyncOp & { user_id: string }): Promise<Record<string, unknown>> {
    const res = await postOps(new Request("https://app.test/api/sync/ops", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...accountHeaderFromCookie(cookie) },
      body: JSON.stringify({ ops: [o] }),
    }));
    expect(res.status).toBe(200);
    const { results } = await res.json() as { results: Record<string, unknown>[] };
    return results[0];
  }

  async function stored(name: string) {
    const { data, error } = await admin.from("food_membership_revisions").select("status, rev")
      .eq("user_id", userId).eq("name_norm", name).single();
    expect(error).toBeNull();
    return { status: data!.status as string | null, rev: Number(data!.rev) };
  }

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;
    const users = await createTestUsers();
    admin = users.admin;
    userId = users.a.userId;
    cookie = await cookieHeaderFor(users.a.client);
  });

  afterAll(async () => {
    if (!admin || names.length === 0) return;
    await admin.from("food_membership_revisions").delete().eq("user_id", userId).in("name_norm", names);
  });

  it("applies the first mark for a name the account never marked", async () => {
    const name = freshName();
    const first = op(name, "eats", 1_000);
    expect(await send(first)).toEqual({ op_id: first.op_id, status: "applied", rev: 1_000, seq: 0 });
    expect(await stored(name)).toEqual({ status: "eats", rev: 1_000 });
  });

  it("applies a first clear of a name the account never marked", async () => {
    const name = freshName();
    const clear = op(name, null, 1_000);
    expect(await send(clear)).toEqual({ op_id: clear.op_id, status: "applied", rev: 1_000, seq: 0 });
    expect(await stored(name)).toEqual({ status: null, rev: 1_000 });
  });

  it("applies a newer mark on a known name instead of rejecting it with the old status", async () => {
    const name = freshName();
    await send(op(name, "eats", 1_000));
    const moved = op(name, "avoid", 2_000);
    expect(await send(moved)).toEqual({ op_id: moved.op_id, status: "applied", rev: 2_000, seq: 0 });
    expect(await stored(name)).toEqual({ status: "avoid", rev: 2_000 });
  });

  // W029 (audit 2026-10-10 A140, migration 20261231110000): the server assigns the revision. A
  // mark whose hint is below the stored revision (another device's clock ran ahead) is the later
  // tap and applies at the next revision; a retried op id is answered and never written again.
  it("applies a mark below the stored revision at the next server revision", async () => {
    const name = freshName();
    await send(op(name, "eats", 1_000));
    await send(op(name, "avoid", 2_000));
    const later = op(name, "eats", 1_500);
    expect(await send(later)).toEqual({ op_id: later.op_id, status: "applied", rev: 2_001, seq: 0 });
    expect(await stored(name)).toEqual({ status: "eats", rev: 2_001 });
  });

  it("answers a retried op from its first result and writes nothing over a later mark", async () => {
    const name = freshName();
    const first = op(name, "eats", 1_000);
    await send(first);
    await send(op(name, "avoid", 2_000));
    expect(await send(first)).toEqual({ op_id: first.op_id, status: "applied", rev: 1_000, seq: 0 });
    expect(await stored(name)).toEqual({ status: "avoid", rev: 2_000 });
  });
});
