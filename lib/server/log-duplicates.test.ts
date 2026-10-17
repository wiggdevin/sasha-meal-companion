// OD16: a duplicate group reaches every device's change feed once it holds two members.
import { describe, expect, it, vi } from "vitest";
import { recordFingerprint } from "@/lib/server/log-duplicates";
import { toBytea } from "@/lib/server/tokens";
import { entryFingerprint } from "@/lib/sync/fingerprint";
import { ENTRY_ID, fakeClient, ITEM_ID, REF_A, req } from "@/tests/helpers/log-fake-client";
import type { LogCommitRequest } from "@/lib/log/contract";

const GROUP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "20000000-0000-4000-8000-000000000002";
const body = req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }],
  { entry_id: OTHER }) as unknown as LogCommitRequest;

async function hex(): Promise<string> {
  return entryFingerprint({ localDate: "2026-09-11", slot: "meal-1",
    eatenAt: "2026-09-11T16:00:00.000Z", items: [{ canonicalFoodId: REF_A, grams: 100, qty: 1, unit: "g" }] });
}

async function setup(members: string[], state = "open", answer: unknown = { status: "applied", rev: 4 }) {
  const fingerprint = toBytea(Buffer.from(await hex(), "hex"));
  return fakeClient({
    tables: {
      duplicate_groups: [{ id: GROUP, fingerprint, local_date: "2026-09-11", slot: "meal-1", state, rev: 3 }],
      duplicate_group_members: members.map((entry_id) => ({ group_id: GROUP, entry_id })),
    },
    rpc: { apply_sync_op: answer },
  });
}

const publishes = (db: Awaited<ReturnType<typeof setup>>) =>
  db.rpc.mock.calls.filter((c) => c[0] === "apply_sync_op");

describe("recordFingerprint publishes a duplicated group (OD16)", () => {
  it("touches the open group through apply_sync_op once it holds two members", async () => {
    const db = await setup([ENTRY_ID, OTHER]);
    await recordFingerprint(db.client, "u1", body);
    const [call] = publishes(db);
    expect(call?.[1]).toMatchObject({ p_user_id: "u1", p_op: {
      entity: "duplicate_groups", entity_id: GROUP, kind: "update", base_rev: 3,
      payload: { id: GROUP, local_date: "2026-09-11", fingerprint: await hex(), slot: "meal-1",
        state: "open", merged_into_entry_id: null, decided_at: null },
    } });
  });

  it("leaves a one-member group off the feed", async () => {
    const db = await setup([OTHER]);
    await recordFingerprint(db.client, "u1", body);
    expect(publishes(db)).toHaveLength(0);
  });

  it("does not touch a group again for a third copy", async () => {
    const db = await setup([ENTRY_ID, OTHER, "20000000-0000-4000-8000-000000000003"]);
    await recordFingerprint(db.client, "u1", body);
    expect(publishes(db)).toHaveLength(0);
  });

  it("opens a new group with no extra read and no publish", async () => {
    const db = fakeClient({ tables: { duplicate_groups: [] }, rpc: { apply_sync_op: { status: "applied" } } });
    await recordFingerprint(db.client, "u1", body);
    expect(vi.mocked(db.client.from).mock.calls.map((c) => c[0])).toEqual(["duplicate_groups", "duplicate_groups",
      "duplicate_group_members"]);
    expect(publishes(db)).toHaveLength(0);
  });

  it("never reopens a group the user already decided", async () => {
    for (const state of ["dismissed", "merged"]) {
      const db = await setup([ENTRY_ID, OTHER], state);
      await recordFingerprint(db.client, "u1", body);
      expect(publishes(db)).toHaveLength(0);
    }
  });

  it("is best-effort: a refused publish is logged, never thrown", async () => {
    const db = await setup([ENTRY_ID, OTHER], "open", { status: "gone" });
    await expect(recordFingerprint(db.client, "u1", body)).resolves.toBeUndefined();
  });
});
