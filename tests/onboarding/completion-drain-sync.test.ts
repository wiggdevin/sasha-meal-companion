/**
 * `flushOutboxNow` is the drain behind the onboarding exit (components/Onboarding/OnboardingFlow.tsx),
 * driven here against a fake IndexedDB and a fake server — no network, no Supabase.
 *
 * The case that matters is R1's: an account that has just been created holds no `user_settings` row
 * at all. A settings op with no baseline to aim at is PARKED by the drain, not sent
 * (lib/sync/settings.ts:148-153), so a flush that only pushed would answer "not accepted" forever and
 * hold a brand-new account inside onboarding. The pull is what proves the server holds no row and
 * installs the empty baseline its `create` needs.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushOutboxNow, pushOutbox } from "@/lib/sync/client";
import { allOps } from "@/lib/sync/idb";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { mirroredOnboardedAt } from "@/lib/profile/onboarding-client";
import type { OpsResponse, SyncOp } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;

const ONBOARDED_AT = "2026-09-20T12:00:00.000Z";
const EMPTY_FEED = { changes: [], next_cursor: 0, has_more: false };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

/** The account's own settings write, queued exactly as onboarding queues it. */
async function queueOnboardedStamp(): Promise<void> {
  await mutateUserSettings(h, (row) => {
    const rev = typeof row.rev === "number" ? row.rev : null;
    return {
      row: { ...row, onboarded_at: ONBOARDED_AT },
      op: {
        op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY,
        kind: rev === null ? "create" as const : "update" as const,
        base_rev: rev,
        payload: { onboarded_at: ONBOARDED_AT },
        client_ts: ONBOARDED_AT,
      },
      result: undefined,
    };
  });
}

/** A server that holds no `user_settings` row and answers every op it is sent. */
function emptyServer() {
  const posted: SyncOp[][] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    posted.push(body.ops);
    return jsonResponse({
      results: body.ops.map((op) => ({ op_id: op.op_id, status: "applied", rev: 1, seq: 1 })),
      server_time: ONBOARDED_AT,
    } satisfies OpsResponse);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

/**
 * A server that HAS the account's settings row — without `onboarded_at` — and answers the whole-row
 * write `unsupported`: the settlement that empties the queue (lib/sync/settings-intents.ts:75)
 * without the server row ever being written.
 */
function unstampedServer() {
  const posted: SyncOp[][] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/sync/changes")) {
      return jsonResponse({
        changes: [{ seq: 1, entity: "user_settings", entity_key: "settings", rev: 7,
          op: "update", at: ONBOARDED_AT, current: { height_cm: 170, onboarded_at: null } }],
        next_cursor: 1, has_more: false,
      });
    }
    const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    posted.push(body.ops);
    return jsonResponse({
      results: body.ops.map((op) => ({ op_id: op.op_id, status: "unsupported" })),
      server_time: ONBOARDED_AT,
    });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("flushOutboxNow", () => {
  it("creates the row for an account the server holds nothing for, and answers accepted", async () => {
    await queueOnboardedStamp();
    expect(await allOps(h)).toHaveLength(1);
    const { fetchFn, posted } = emptyServer();

    await expect(flushOutboxNow(h, { fetchFn })).resolves.toBe(true);

    expect(posted[0]).toHaveLength(1);
    expect(posted[0][0]).toMatchObject({
      entity: "user_settings", entity_id: USER_SETTINGS_KEY, kind: "create",
      payload: { onboarded_at: ONBOARDED_AT },
    });
    await expect(allOps(h)).resolves.toEqual([]);
  });

  it("answers not-accepted and keeps the write queued when the pass cannot reach the server", async () => {
    await queueOnboardedStamp();
    const fetchFn = vi.fn(async () => { throw new Error("offline"); });

    await expect(flushOutboxNow(h, { fetchFn: fetchFn as unknown as typeof fetch }))
      .resolves.toBe(false);
    await expect(allOps(h)).resolves.toMatchObject([{ entity: "user_settings" }]);
  });

  it("sends the write a push alone would park, because the pull proves the server holds no row", async () => {
    await queueOnboardedStamp();
    const { fetchFn } = emptyServer();

    // The push-only path: no confirmed baseline, so the op is held back rather than sent.
    await expect(pushOutbox(h, { fetchFn })).resolves.toMatchObject({ pushed: 0, failed: true });
    await expect(allOps(h)).resolves.toMatchObject([{ entity: "user_settings" }]);

    await expect(flushOutboxNow(h, { fetchFn })).resolves.toBe(true);
    await expect(allOps(h)).resolves.toEqual([]);
  });

  it("answers not-accepted, rather than throwing, when the outbox cannot be read at all", async () => {
    // `queued()` sits outside the old try: a device with no usable IndexedDB has to get the flow's
    // warning answer, never a rejected promise the flow would report as the generic save failure.
    globalThis.indexedDB = undefined as unknown as IDBFactory;

    await expect(flushOutboxNow(h, { fetchFn: vi.fn() as unknown as typeof fetch }))
      .resolves.toBe(false);
  });

  it("empties the queue on a settled drop, so the mirrored stamp is what says accepted", async () => {
    await queueOnboardedStamp();
    const { fetchFn, posted } = unstampedServer();

    // The drain's own answer is "nothing is queued" — the hole finding 3 names.
    await expect(flushOutboxNow(h, { fetchFn })).resolves.toBe(true);
    await expect(allOps(h)).resolves.toEqual([]);
    expect(posted.flat()).toMatchObject([{ entity: "user_settings", kind: "update" }]);

    // ...and the mirror the flow reads never carried the stamp the gate opens on.
    await expect(mirroredOnboardedAt()).resolves.toBeNull();
  });
});
