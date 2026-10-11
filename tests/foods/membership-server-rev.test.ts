/**
 * W029 (audit 2026-10-10 A140, A039): food membership revisions come from the server, and the
 * phone's mark cache follows the server's marks.
 *
 * - A tap asks for one past the newest revision this device knows of, never its clock; the sync
 *   route hands the op id to `set_food_membership`, which assigns the revision it writes.
 * - Two tabs that asked for one revision both land; the later tap wins and neither is reverted.
 *   (A retried op id answering its first result is proved on Postgres:
 *   tests/migrations/membership-server-rev-sql.test.ts.)
 * - An applied op moves the cache to the server's revision; a server mark (a Favor, another
 *   device) replaces the cache on the next pass, so a repeat tap is never a silent no-op.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFoodMembershipState, adoptServerMemberships, foodMembershipWriteMark, readFoodMembership,
  reserveFoodMembershipIntent, setFoodMembership,
} from "@/lib/foods/prefs-client";
import { __resetStoreCache } from "@/lib/store";
import { allOps, deleteOp } from "@/lib/sync/idb";
import { applyResult } from "@/lib/sync/outbox";
import type { OpResult } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;
const USER_ID = "11111111-1111-4111-8111-111111111111";

const route = vi.hoisted(() => ({ rpc: vi.fn(), requireUser: vi.fn(), enforceRateLimit: vi.fn() }));
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => route.requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({
  enforceRateLimit: (...args: unknown[]) => route.enforceRateLimit(...args),
}));
const { POST } = await import("@/app/api/sync/ops/route");

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
}

const client = () => ({ auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: USER_ID } } })) } }) as never;

/** The server's rule (migration 20261231110000): rev = greatest(hint, stored + 1), once per op id. */
function fakeServer() {
  const marks = new Map<string, { status: string | null; rev: number }>();
  const seen = new Map<string, Record<string, unknown>>();
  route.rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    const prior = seen.get(String(args.p_op_id));
    if (prior) return { data: { ...prior, duplicate: true }, error: null };
    const name = String(args.p_name_norm);
    const rev = Math.max(Number(args.p_rev), (marks.get(name)?.rev ?? -1) + 1);
    marks.set(name, { status: args.p_status as string | null, rev });
    const result = { rev, status: args.p_status, updated: 1, truncated: false };
    seen.set(String(args.p_op_id), result);
    return { data: { ...result, duplicate: false }, error: null };
  });
  return marks;
}

async function push(): Promise<OpResult[]> {
  const ops = await allOps(h);
  const response = await POST(new Request("https://x.test/api/sync/ops", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: ops.map(({ op_id, entity, entity_id, kind, base_rev, payload, client_ts }) =>
      ({ user_id: USER_ID, op_id, entity, entity_id, kind, base_rev, payload, client_ts })) }),
  }));
  const { results } = await response.json() as { results: OpResult[] };
  for (const [i, result] of results.entries()) await applyResult(h, result, ops[i], () => 5_000);
  return results;
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("localStorage", memoryStorage());
  __resetStoreCache();
  __resetFoodMembershipState();
  route.rpc.mockReset();
  route.enforceRateLimit.mockReset().mockResolvedValue(undefined);
  route.requireUser.mockReset().mockResolvedValue({ userId: USER_ID, client: { rpc: route.rpc } });
});

describe("server-assigned membership revisions", () => {
  it("asks for one past the newest known revision, never the device clock", async () => {
    await setFoodMembership("Kiwi", "eats", { supabase: client(), now: () => 1_800_003_600_000 });
    await setFoodMembership("Kiwi", "avoid", { supabase: client(), now: () => 1_800_003_600_000 });
    expect((await allOps(h)).map((op) => op.payload.rev)).toEqual([1, 2]);
    expect(readFoodMembership(USER_ID, "kiwi")).toMatchObject({ status: "avoid", rev: 2 });
  });

  it("sends the op id, and takes the server's revision when it is higher", async () => {
    const marks = fakeServer();
    marks.set("peanut butter", { status: "eats", rev: 1_800_003_600_000 }); // a clock-skewed device
    await setFoodMembership("Peanut butter", "avoid", { supabase: client() });
    const [op] = await allOps(h);
    expect(await push()).toEqual([{ op_id: op.op_id, status: "applied", rev: 1_800_003_600_001, seq: 0 }]);
    expect(route.rpc).toHaveBeenCalledWith("set_food_membership", expect.objectContaining({
      p_op_id: op.op_id, p_rev: 1, p_status: "avoid" }));
    expect(readFoodMembership(USER_ID, "peanut butter")).toMatchObject({ status: "avoid", rev: 1_800_003_600_001 });
    expect(await allOps(h)).toEqual([]);
    // The next tap asks past the server's revision.
    await setFoodMembership("Peanut butter", "eats", { supabase: client() });
    expect((await allOps(h))[0].payload.rev).toBe(1_800_003_600_002);
  });

  it("two tabs that asked for one revision: both land, the later tap wins, nothing is reverted", async () => {
    const marks = fakeServer();
    // Tab 1 reserves; tab 2 (its own memory, the same cache) reserves before tab 1 caches.
    const first = reserveFoodMembershipIntent("Rice", h, 100);
    __resetFoodMembershipState();
    const second = reserveFoodMembershipIntent("Rice", h, 100);
    expect(second.rev).toBe(first.rev);
    await setFoodMembership("Rice", "eats", { supabase: client(), intent: first });
    await setFoodMembership("Rice", "avoid", { supabase: client(), intent: second });
    const results = await push();
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(marks.get("rice")).toEqual({ status: "avoid", rev: first.rev + 1 });
    expect(readFoodMembership(USER_ID, "rice")).toMatchObject({ status: "avoid", rev: first.rev + 1 });
  });
});

describe("the mark cache follows the server (A039)", () => {
  it("a server Favor after a local clear: the repeat clear queues an op instead of a no-op", async () => {
    const supabase = client();
    await setFoodMembership("Kiwi", null, { supabase });
    const [cleared] = await allOps(h);
    await deleteOp(h, cleared.op_id); // it synced
    // The server Favor (or another device) marks the family; the next sync pass reads it.
    const mark = foodMembershipWriteMark();
    expect(adoptServerMemberships(h, [{ name_norm: "kiwi", status: "eats", note: null, rev: 7 }], new Set(), mark))
      .toBe(1);
    expect(readFoodMembership(USER_ID, "kiwi")).toEqual({ status: "eats", note: null, rev: 7 });
    await setFoodMembership("Kiwi", null, { supabase });
    expect((await allOps(h)).map((op) => [op.payload.status, op.payload.rev])).toEqual([[null, 8]]);
  });

  it("keeps a queued name, and a tap made after the pass's server read", async () => {
    const supabase = client();
    await setFoodMembership("Rice", "avoid", { supabase });
    const mark = foodMembershipWriteMark();
    await setFoodMembership("Tofu", "eats", { supabase });
    const rows = [
      { name_norm: "rice", status: "eats" as const, note: null, rev: 40 },
      { name_norm: "tofu", status: null, note: null, rev: 41 },
    ];
    expect(adoptServerMemberships(h, rows, new Set(["rice"]), mark)).toBe(0);
    expect(readFoodMembership(USER_ID, "rice")?.status).toBe("avoid");
    expect(readFoodMembership(USER_ID, "tofu")?.status).toBe("eats");
    expect(adoptServerMemberships(h, rows, new Set(), foodMembershipWriteMark())).toBe(2);
    expect(readFoodMembership(USER_ID, "rice")).toMatchObject({ status: "eats", rev: 40 });
  });
});
