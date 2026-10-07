// tests/sync/two-client.test.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { mergeEntity, rebaseOp } from "@/lib/sync/merge";
import type { ChangeRow, OpResult, SyncOp } from "@/lib/sync/types";

const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const live = Boolean(URL && KEY);

let admin: SupabaseClient;
let userId: string;

async function apply(op: SyncOp): Promise<OpResult> {
  const { data, error } = await admin.rpc("apply_sync_op", { p_user_id: userId, p_op: op });
  if (error) throw new Error(error.message);
  return data as OpResult;
}

async function changes(since: number, limit = 500): Promise<ChangeRow[]> {
  const { data, error } = await admin.rpc("sync_changes", {
    p_user_id: userId, p_since: since, p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ChangeRow[];
}

const waterOp = (over: Partial<SyncOp> = {}): SyncOp => ({
  op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-12", kind: "update",
  base_rev: 1, payload: { local_date: "2026-09-12", cups: 1 },
  client_ts: new Date().toISOString(), ...over,
});

// Ruling: update payloads are full rows: apply_sync_op upserts every column
// from the payload, so a partial payload fails on the row's not-null columns.
const entryRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, local_date: "2026-09-11", tz: "America/New_York", slot: "meal-1", method: "plan",
  eaten_at: "2026-09-11T16:00:00.000Z", note: null, items: [], ...over,
});

const entryOp = (id: string, over: Partial<SyncOp> = {}): SyncOp => ({
  op_id: crypto.randomUUID(), entity: "log_entries", entity_id: id, kind: "create",
  base_rev: null, client_ts: new Date().toISOString(),
  payload: entryRow(id),
  ...over,
});

describe.skipIf(!live)("two clients and an MCP writer against a branch", () => {
  beforeAll(async () => {
    admin = createClient(URL!, KEY!, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.createUser({
      email: `p0-sync-${crypto.randomUUID()}@example.test`, email_confirm: true,
    });
    if (error) throw new Error(error.message);
    userId = data.user!.id;
  });

  it("applies a create and starts the cursor at 1", async () => {
    const id = crypto.randomUUID();
    expect(await apply(entryOp(id))).toMatchObject({ status: "applied", rev: 1, seq: 1 });
    const feed = await changes(0);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ entity: "log_entries", entity_key: id, op: "create", rev: 1 });
    expect(feed[0].current).toMatchObject({ slot: "meal-1" });
  });

  it("is idempotent on op_id", async () => {
    const op = entryOp(crypto.randomUUID());
    await apply(op);
    expect(await apply(op)).toMatchObject({ status: "duplicate" });
  });

  it("rejects a stale update with the full current entity, writing nothing", async () => {
    const id = crypto.randomUUID();
    await apply(entryOp(id));
    await apply(entryOp(id, { kind: "update", base_rev: 1, payload: entryRow(id, { slot: "meal-2" }) }));
    const stale = await apply(
      entryOp(id, { kind: "update", base_rev: 1, payload: entryRow(id, { slot: "meal-3" }) }),
    ) as Extract<OpResult, { status: "conflict" }>;
    expect(stale).toMatchObject({ status: "conflict", current_rev: 2 });
    expect(stale.current).toMatchObject({ slot: "meal-2" });
  });

  it("merges a conflict to the larger cups, and the rebase lands", async () => {
    const before = (await changes(0)).at(-1)?.seq ?? 0;
    await apply(waterOp({ kind: "create", base_rev: null }));
    await apply(waterOp({ base_rev: 1, payload: { local_date: "2026-09-12", cups: 5 } }));
    const conflicted = await apply(
      waterOp({ base_rev: 1, payload: { local_date: "2026-09-12", cups: 3 } }),
    ) as Extract<OpResult, { status: "conflict" }>;
    expect(conflicted.status).toBe("conflict");
    const merged = mergeEntity("water_log",
      { local_date: "2026-09-12", cups: 3 },
      conflicted.current as Record<string, unknown>,
      new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
    expect(merged.cups).toBe(5);
    expect(await apply(rebaseOp(waterOp({ base_rev: 1 }), merged, conflicted.current_rev)))
      .toMatchObject({ status: "applied" });
    expect((await changes(before)).at(-1)!.current).toMatchObject({ cups: 5 });
  });

  it("never resurrects a tombstone, and only restore revives it", async () => {
    const id = crypto.randomUUID();
    await apply(entryOp(id));
    await apply(entryOp(id, { kind: "delete", base_rev: 1, payload: {} }));
    const stale = await apply(
      entryOp(id, { kind: "update", base_rev: 1, payload: entryRow(id, { slot: "meal-3" }) }),
    );
    expect(stale.status).toBe("deleted");
    expect(await apply(entryOp(id, { kind: "restore", base_rev: 2, payload: {} })))
      .toMatchObject({ status: "applied", rev: 3 });
  });

  it("answers gone for an entity_id the server never had", async () => {
    const id = crypto.randomUUID();
    expect(await apply(entryOp(id, { kind: "update", base_rev: 1, payload: entryRow(id) })))
      .toMatchObject({ status: "gone" });
  });

  it("replays an offline batch in order and keeps the cursor contiguous", async () => {
    const before = (await changes(0)).at(-1)?.seq ?? 0;
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await apply(entryOp(id));
    const feed = await changes(before);
    expect(feed.map((c) => c.entity_key)).toEqual(ids);
    expect(feed.map((c) => c.seq)).toEqual([before + 1, before + 2, before + 3]);
  });

  it("pages the feed without skipping a change", async () => {
    const all = await changes(0);
    const first = await changes(0, 2);
    const rest = await changes(first.at(-1)!.seq);
    expect([...first, ...rest].map((c) => c.seq)).toEqual(all.map((c) => c.seq));
  });
});
