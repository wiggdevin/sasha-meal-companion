import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eatsByRole, rotationPool, type Food } from "@/lib/foods";
import {
  __resetFoodMembershipState,
  readFoodMembership,
  setFoodMembership,
} from "@/lib/foods/prefs-client";
import {
  __resetStoreCache, getFoods, loadStore, saveStore, setFoodStatus, upsertFood,
} from "@/lib/store";
import { allOps } from "@/lib/sync/idb";
import { applyResult } from "@/lib/sync/outbox";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const USER_ID = "11111111-1111-4111-8111-111111111111";

const routeMocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireUser: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => routeMocks.requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({
  enforceRateLimit: (...args: unknown[]) => routeMocks.enforceRateLimit(...args),
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

function client() {
  return {
    auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: USER_ID } } })) },
  } as never;
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("localStorage", memoryStorage());
  __resetStoreCache();
  __resetFoodMembershipState();
  routeMocks.rpc.mockReset();
  routeMocks.enforceRateLimit.mockReset().mockResolvedValue(undefined);
  routeMocks.requireUser.mockReset().mockResolvedValue({
    userId: USER_ID,
    client: { rpc: routeMocks.rpc },
  });
});

describe("normalized food membership", () => {
  it("queues one normalized-name operation and caches the intended state", async () => {
    await setFoodMembership("  Watermélon, raw  ", "avoid", {
      supabase: client(), note: "hurt on 9/12", now: () => 1_800_000_000_000,
    });

    const [op] = await allOps(h);
    expect(op).toMatchObject({
      entity: "food_membership",
      kind: "update",
      base_rev: null,
      payload: {
        name_norm: "watermelon",
        status: "avoid",
        note: "hurt on 9/12",
        rev: 1_800_000_000_000,
      },
    });
    expect(readFoodMembership(USER_ID, "watermelon")).toMatchObject({
      status: "avoid", note: "hurt on 9/12", rev: 1_800_000_000_000,
    });
  });

  it("is idempotent for the same cached intent and neutral stays cached as absence", async () => {
    const supabase = client();
    await setFoodMembership("Rice", null, { supabase, note: "keep this note", now: () => 100 });
    await setFoodMembership("rice, cooked", null, { supabase, note: "keep this note", now: () => 200 });

    expect(await allOps(h)).toHaveLength(1);
    expect(readFoodMembership(USER_ID, "RICE")).toEqual({
      status: null, note: "keep this note", rev: 100,
    });
  });

  it("advances the revision when membership changes", async () => {
    const supabase = client();
    await setFoodMembership("Rice", "eats", { supabase, now: () => 100 });
    await setFoodMembership("Rice", "avoid", { supabase, now: () => 100 });

    const ops = await allOps(h);
    expect(ops.map((op) => op.payload.rev)).toEqual([100, 101]);
    expect(readFoodMembership(USER_ID, "Rice")?.status).toBe("avoid");
  });

  it("queues only the latest same-tick intent when an earlier one is superseded", async () => {
    const supabase = client();
    await Promise.all([
      setFoodMembership("Rice", "eats", { supabase, now: () => 100 }),
      setFoodMembership("Rice", "avoid", { supabase, now: () => 100 }),
    ]);

    expect((await allOps(h)).map((op) => ({ status: op.payload.status, rev: op.payload.rev })))
      .toEqual([{ status: "avoid", rev: 101 }]);
    expect(readFoodMembership(USER_ID, "Rice")?.status).toBe("avoid");
  });

  it.each(["eats", "avoid", null] as const)(
    "drives status %s through the sync route into set_food_membership",
    async (status) => {
      const revision = status === "eats" ? 101 : status === "avoid" ? 102 : 103;
      const operation = {
        user_id: USER_ID, // Phase 9 §0.5: an op names its owner
        op_id: crypto.randomUUID(),
        entity: "food_membership",
        entity_id: crypto.randomUUID(),
        kind: "update",
        base_rev: null,
        payload: {
          id: crypto.randomUUID(), name_norm: "watermelon", status,
          note: "keep", rev: revision,
        },
        client_ts: "2026-09-19T12:00:00.000Z",
      };
      routeMocks.rpc.mockResolvedValue({
        data: { rev: revision, status, updated: 2, truncated: false }, error: null,
      });

      const response = await POST(new Request("https://x.test/api/sync/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops: [operation] }),
      }));

      expect(response.status).toBe(200);
      expect(routeMocks.rpc).toHaveBeenCalledWith("set_food_membership", {
        p_user: USER_ID,
        p_name_norm: "watermelon",
        p_status: status,
        p_note: "keep",
        p_rev: revision,
      });
    },
  );

  it("reconciles a stale outbox rejection to the newer server membership", async () => {
    saveStore(loadStore(), { silent: true });
    upsertFood({
      id: "watermelon", name: "watermelon", role: "carb", unit: "cup",
      perUnit: { protein: 0.9, carbs: 11.5, fat: 0.2 },
      status: "avoid", updatedAt: "2026-09-19T00:00:00.000Z",
    });
    await setFoodMembership("Watermelon, raw", "avoid", {
      supabase: client(), now: () => 100,
    });
    const [queued] = await allOps(h);

    await applyResult(h, {
      op_id: queued.op_id,
      status: "rejected",
      user_id: USER_ID,
      name_norm: "watermelon",
      current_status: "eats",
      current_rev: 200,
    }, queued, () => 300);

    expect(readFoodMembership(USER_ID, "watermelon")).toMatchObject({
      status: "eats", rev: 200,
    });
    expect(getFoods().watermelon.status).toBe("eats");
    expect(await allOps(h)).toEqual([]);
  });

  /* Design §7.1: the store no longer ships a seed, so the food this rule is about is built here
     rather than assumed to exist on a fresh device. */
  it("neutral is in neither selector and never enters the rotation pool", () => {
    saveStore(loadStore(), { silent: true });
    upsertFood({
      id: "white-rice", name: "white rice", role: "carb", unit: "g",
      perUnit: { protein: 0.027, carbs: 0.28, fat: 0.003 },
      status: "eats", updatedAt: "2026-09-19T00:00:00.000Z",
    });
    const rice = getFoods()["white-rice"];
    setFoodStatus(rice.id, "neutral");
    const foods = getFoods();

    expect(eatsByRole(foods).carb.some((food) => food.id === rice.id)).toBe(false);
    const pool = rotationPool("rest", "meal-1", {
      kcal: 500, protein: 30, carbs: 50, fat: 20,
    }, foods);
    expect(pool.flatMap((meal) => meal.components)
      .some((component) => component.name === rice.name)).toBe(false);
    expect((foods[rice.id] as Food).status).toBe("neutral");
  });
});
