/**
 * T1 §1 / U3 — every Avoid/Eats mark becomes one normalized-name membership op.
 *
 * The seam is the Supabase client (`opts.supabase`): the two RPCs and the one `user_foods` read
 * are the only network this file has, and counting them is how "a repeat run is a no-op" is
 * proved. IndexedDB is faked; `localStorage` is an in-memory store, as in lib/estimator-client.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import {
  FOOD_PREF_REFS_KEY, __backfillFailures, __resetBackfillState, backfillFoodPrefs,
  FOOD_MEMBERSHIP_TRUNCATED_MESSAGE, FoodMembershipSaveError, readFoodMembership, readPrefRefCache,
  reserveFoodMembershipIntent, setFoodMembership, syncFoodPref,
  saveFoodEdits,
  verifyFoodNutrientsEditable,
} from "@/lib/foods/prefs-client";
import { allOps } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import { unbindAccount, type AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";

function food(over: Partial<Food> = {}): Food {
  return {
    id: "white-rice", name: "White rice, cooked", role: "carb", unit: "cup",
    perUnit: { protein: 4.3, carbs: 44.5, fat: 0.4 },
    status: "eats", updatedAt: "2026-09-17T00:00:00.000Z", ...over,
  };
}

type UserFoodRow = {
  id: string; name: string; catalog_food_id: number | null; created_at?: string; rev?: number;
};

type Fake = {
  client: unknown;
  rpcCalls: { kind: string; catalogFoodId: number | null; userFoodId: string | null }[];
  reads: number;
  inserted: Record<string, unknown>[];
  updates: { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }[];
};

type Order = { column: string; ascending: boolean; nullsFirst: boolean };

/** A Supabase double narrow enough to be honest: only the calls prefs-client actually makes. */
function fakeSupabase(opts: {
  rows?: UserFoodRow[];
  userId?: string | null;
  /** How many `kind: "catalog"` ref calls to refuse before answering normally. */
  failCatalogRefs?: number;
  /** Food names whose `user_foods` write is always refused — a food that can never resolve. */
  failNames?: string[];
  /** Claims answered in order, last repeating: an account that changes mid-call. */
  userIds?: (string | null)[];
  /** Awaited inside the FIRST `user_foods` read, so a run can be parked exactly there. */
  beforeFirstRead?: () => Promise<void> | void;
  /** Fired after every `get_or_create_food_ref`, for ordering assertions. */
  onRpc?: () => void;
  membershipResult?: { rev: number; status: "eats" | "avoid" | null;
    updated: number; truncated: boolean };
} = {}): Fake {
  const rows = [...(opts.rows ?? [])];
  const refused = new Set(opts.failNames ?? []);
  const out: Fake = { client: null, rpcCalls: [], reads: 0, inserted: [], updates: [] };
  const claims = opts.userIds
    ?? [opts.userId === null ? null : (opts.userId ?? USER_ID)];
  let claimCalls = 0;
  let reads = 0;
  let refSeq = 0;
  let catalogFailures = opts.failCatalogRefs ?? 0;
  const refs = new Map<string, string>();
  const refFor = (key: string): string => {
    const known = refs.get(key);
    if (known) return known;
    refSeq += 1;
    const id = `22222222-2222-4222-8222-${String(refSeq).padStart(12, "0")}`;
    refs.set(key, id);
    return id;
  };

  const from = (table: string) => {
    if (table !== "user_foods" && table !== "user_food_prefs") throw new Error(`unexpected table ${table}`);
    const filters: Record<string, unknown> = {};
    const orders: Order[] = [];
    let staged: UserFoodRow | null = null;
    let refusedWrite = false;
    let patch: Record<string, unknown> | null = null;
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
      in: () => chain,
      is: () => chain,
      limit: () => chain,
      order: (column: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        orders.push({
          column, ascending: o.ascending !== false, nullsFirst: o.nullsFirst === true,
        });
        return chain;
      },
      update: (value: Record<string, unknown>) => { patch = value; return chain; },
      upsert: (row: Record<string, unknown>) => {
        out.inserted.push(row);
        if (refused.has(String(row.name))) { refusedWrite = true; return chain; }
        staged = { id: String(row.id), name: String(row.name), catalog_food_id: null };
        rows.push(staged);
        return chain;
      },
      maybeSingle: async () => {
        if (patch) {
          out.updates.push({ table, patch, filters: { ...filters } });
          if (table === "user_food_prefs") return { data: { food_ref_id: filters.food_ref_id }, error: null };
          const matched = rows.find((r) => r.id === filters.id && r.rev === filters.rev);
          if (!matched) return { data: null, error: null };
          Object.assign(matched, patch);
          return { data: { id: matched.id }, error: null };
        }
        if (refusedWrite) return { data: null, error: { message: "refused" } };
        if (staged) return { data: staged, error: null };
        reads += 1;
        if (reads === 1) await opts.beforeFirstRead?.();
        out.reads += 1;
        const matched = rows.filter((r) => r.name === filters.name);
        // PostgREST applies `.order()` in the order it was chained; nulls sort last unless asked.
        const sorted = [...matched].sort((a, b) => {
          for (const o of orders) {
            const av = (a as unknown as Record<string, unknown>)[o.column] ?? null;
            const bv = (b as unknown as Record<string, unknown>)[o.column] ?? null;
            if (av === bv) continue;
            if (av === null) return o.nullsFirst ? -1 : 1;
            if (bv === null) return o.nullsFirst ? 1 : -1;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return o.ascending ? cmp : -cmp;
          }
          return 0;
        });
        return { data: sorted[0] ?? null, error: null };
      },
    };
    return chain;
  };

  out.client = {
    auth: {
      getClaims: async () => {
        const sub = claims[Math.min(claimCalls, claims.length - 1)];
        claimCalls += 1;
        return { data: sub === null ? null : { claims: { sub } } };
      },
    },
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "set_food_membership" && opts.membershipResult) {
        return { data: opts.membershipResult, error: null };
      }
      if (name !== "get_or_create_food_ref") return { data: null, error: { message: "no" } };
      out.rpcCalls.push({
        kind: String(args.p_kind),
        catalogFoodId: (args.p_catalog_food_id as number | null) ?? null,
        userFoodId: (args.p_user_food_id as string | null) ?? null,
      });
      if (args.p_kind === "catalog" && catalogFailures > 0) {
        catalogFailures -= 1;
        return { data: null, error: { message: "refused" } };
      }
      opts.onRpc?.();
      return {
        data: refFor(args.p_kind === "user"
          ? `user:${args.p_user_food_id}` : `catalog:${args.p_catalog_food_id}`),
        error: null,
      };
    },
  };
  return out;
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  } as Storage;
}

const client = (fake: Fake) => ({ supabase: fake.client as never });

/** Let every queued microtask and timer callback drain, so a parked run really is parked. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A serialised pair deadlocks rather than fails, so say which it was. */
async function within<T>(work: Promise<T>, ms: number, complaint: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(complaint)), ms);
  });
  try {
    return await Promise.race([work, alarm]);
  } finally {
    clearTimeout(timer!);
  }
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  __resetBackfillState();
});

describe("syncFoodPref", () => {
  it("refuses nutrition edits on a mapped catalog food", async () => {
    const mapped = food({ catalogFoodId: 42 });
    const fake = fakeSupabase({ rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: mapped.name, catalog_food_id: 42, rev: 1 }] });
    await expect(saveFoodEdits(mapped, "", mapped.role,
      { ...mapped.perUnit, protein: mapped.perUnit.protein + 1 }, client(fake)))
      .rejects.toThrow(/nutrition values/);
    expect(fake.updates).toEqual([]);
  });

  it("hides nutrition fields when the matching server row is mapped despite a local missing marker", async () => {
    const own = food({ catalogFoodId: undefined, unit: "g" });
    const fake = fakeSupabase({ rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: own.name, catalog_food_id: 42, rev: 1 }] });
    expect(await verifyFoodNutrientsEditable(own, fake.client as never)).toBe(false);
  });

  it("a Foods-tab mark queues one name-wide membership op and no per-ref status op", async () => {
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null }],
    });
    await syncFoodPref(food({ status: "avoid", note: "hurt on 9/12" }), client(fake));

    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      entity: "food_membership", kind: "update", base_rev: null,
      payload: { name_norm: "white rice", status: "avoid", note: "hurt on 9/12" },
    });
    expect(ops.some((op) => op.entity === "user_food_prefs")).toBe(false);
  });

  it("mints both refs for a mapped row but still queues one name-wide op", async () => {
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: 4242 }],
    });
    await syncFoodPref(food({ status: "avoid" }), client(fake));

    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: "food_membership" });
    expect(fake.rpcCalls).toEqual([
      { kind: "user", catalogFoodId: null, userFoodId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { kind: "catalog", catalogFoodId: 4242, userFoodId: null },
    ]);
    expect(readPrefRefCache(USER_ID)["white-rice"].catalogRefId).toBeDefined();
  });

  it("throws a typed save error on a half-resolved Foods-tab mark, then retries cleanly", async () => {
    // The catalog ref is what search, the scanner and the coach read. Caching the user ref alone
    // would make every later call a no-op and strand the pref where nothing reads it.
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: 4242 }],
      failCatalogRefs: 1,
    });
    await expect(setFoodMembership("White rice, cooked", "avoid", {
      ...client(fake), food: food({ status: "avoid" }),
    })).rejects.toBeInstanceOf(FoodMembershipSaveError);
    expect(await allOps(h)).toEqual([]);
    expect(readPrefRefCache(USER_ID)).toEqual({});

    await syncFoodPref(food({ status: "avoid" }), client(fake));
    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: "food_membership" });
    expect(fake.rpcCalls.filter((c) => c.kind === "catalog")).toHaveLength(2);
    expect(readPrefRefCache(USER_ID)["white-rice"].catalogRefId).toBeDefined();
  });

  it("prefers the mapped row when two of her foods share a name", async () => {
    const fake = fakeSupabase({
      rows: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null, created_at: "2026-09-01" },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "White rice, cooked", catalog_food_id: 4242, created_at: "2026-09-02" },
      ],
    });
    await syncFoodPref(food({ status: "avoid" }), client(fake));
    expect(fake.rpcCalls).toEqual([
      { kind: "user", catalogFoodId: null, userFoodId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { kind: "catalog", catalogFoodId: 4242, userFoodId: null },
    ]);
    expect(await allOps(h)).toHaveLength(1);
  });

  it("inserts a user_foods row with a deterministic id when she has none", async () => {
    const fake = fakeSupabase({ rows: [] });
    await syncFoodPref(food(), client(fake));
    const [row] = fake.inserted;
    expect(row).toMatchObject({
      user_id: USER_ID, name: "White rice, cooked", kind: "custom", allergen_tags: [],
    });
    // T9 §5: exactly the four NUTRIENT_CODES compute_item_snapshot can join on — asserted as a
    // whole object, so a leftover `protein_g` alongside them fails instead of passing quietly.
    expect(row.per_100g).toEqual({
      energy_kcal: 126, protein: 2.7, carbohydrate: 28.2, fat_total: 0.3,
    });

    // Same slug, same user, same id — a second device mints the row, not a duplicate.
    const again = fakeSupabase({ rows: [] });
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    await syncFoodPref(food(), client(again));
    expect(again.inserted[0].id).toBe(row.id);
  });

  it("never throws on a unit with no household portion — per_100g is empty instead", async () => {
    const fake = fakeSupabase({ rows: [] });
    await syncFoodPref(food({ id: "onion", name: "Onion", unit: "cup" }), client(fake));
    expect(fake.inserted[0].per_100g).toEqual({});
    expect(await allOps(h)).toHaveLength(1);
  });

  it("queues a new name-wide revision when the status changes (F-021: the note survives)", async () => {
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null }],
    });
    await syncFoodPref(food({ status: "avoid", note: "hurt on 9/12" }), client(fake));
    await syncFoodPref(food({ status: "eats", note: "hurt on 9/12" }), client(fake));
    const ops = await allOps(h);
    expect(ops).toHaveLength(2);
    expect(Number(ops[1].payload.rev)).toBeGreaterThan(Number(ops[0].payload.rev));
    expect(ops.at(-1)?.payload).toMatchObject({ status: "eats", note: "hurt on 9/12" });
  });

  it("keeps a later Avoid mark when an earlier Eats note save resolves refs last", async () => {
    let entered!: () => void;
    let release!: () => void;
    const firstRead = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null }],
      beforeFirstRead: async () => { entered(); await held; },
    });

    const noteSave = setFoodMembership("White rice, cooked", "eats", {
      ...client(fake), food: food(), note: "first note",
    });
    await firstRead;
    await setFoodMembership("White rice, cooked", "avoid", {
      ...client(fake), food: food({ status: "avoid" }), note: "hurt on 9/12",
    });
    release();
    await noteSave;

    const ops = await allOps(h);
    expect(ops.map((op) => op.payload.status)).toEqual(["avoid"]);
    expect(ops[0].payload.note).toBe("hurt on 9/12");
    expect(readFoodMembership(USER_ID, "White rice, cooked"))
      .toMatchObject({ status: "avoid", note: "hurt on 9/12" });
  });

  it("drops an earlier reserved mark when its caller reads the previous status late", async () => {
    const fake = fakeSupabase();
    const earlier = reserveFoodMembershipIntent("White rice, cooked", h);
    const later = reserveFoodMembershipIntent("White rice, cooked", h);
    await setFoodMembership("White rice, cooked", "avoid", {
      ...client(fake), intent: later,
    });
    await setFoodMembership("White rice, cooked", "eats", {
      ...client(fake), intent: earlier,
    });
    const ops = await allOps(h);
    expect(ops.map((op) => op.payload.status)).toEqual(["avoid"]);
    expect(readFoodMembership(USER_ID, "White rice, cooked")?.status).toBe("avoid");
  });

  it("is a no-op when the status and note are unchanged — no network, no op", async () => {
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null }],
    });
    await syncFoodPref(food(), client(fake));
    const before = { rpc: fake.rpcCalls.length, reads: fake.reads, ops: (await allOps(h)).length };

    await syncFoodPref(food(), client(fake));
    expect(fake.rpcCalls).toHaveLength(before.rpc);
    expect(fake.reads).toBe(before.reads);
    expect(await allOps(h)).toHaveLength(before.ops);
  });

  it("re-uses the cached refs for a status change — no second round of RPCs", async () => {
    const fake = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: 4242 }],
    });
    await syncFoodPref(food(), client(fake));
    await syncFoodPref(food({ status: "avoid" }), client(fake));
    expect(fake.rpcCalls).toHaveLength(2);
    expect(await allOps(h)).toHaveLength(2);
  });

  it("stays silent and uncached when she is signed out", async () => {
    // "Signed out" is now "no account bound" (Phase 9 §0.1): setFoodMembership's own
    // `accountHandle()` throws, and syncFoodPref's retry-only catch swallows it.
    const fake = fakeSupabase({ userId: null });
    unbindAccount();
    await syncFoodPref(food(), client(fake));
    h = await resetTestAccount();
    expect(await allOps(h)).toEqual([]);
    expect(readPrefRefCache(USER_ID)).toEqual({});
  });

  it("throws AccountNotBound for a direct mark while signed out", async () => {
    const fake = fakeSupabase({ userId: null });
    unbindAccount();

    await expect(setFoodMembership("White rice, cooked", "avoid", client(fake)))
      .rejects.toMatchObject({
        name: "AccountNotBound",
        message: "No account is bound on this device.",
      });
    h = await resetTestAccount();
    expect(await allOps(h)).toEqual([]);
  });

  it("returns the client warning only when the immediate membership acknowledgement is truncated", async () => {
    const fake = fakeSupabase({
      membershipResult: {
        rev: 1_900_000_000_000, status: "avoid", updated: 50, truncated: true,
      },
    });

    const result = await setFoodMembership("White rice, cooked", "avoid", {
      ...client(fake), now: () => 1_900_000_000_000, acknowledge: true,
    });

    expect(result).toEqual({ updated: 50, truncated: true });
    expect(FOOD_MEMBERSHIP_TRUNCATED_MESSAGE)
      .toBe("Marked; some duplicate catalog rows were skipped");
    expect(await allOps(h)).toHaveLength(1);
  });

  it("keeps each account's refs to itself", async () => {
    const hers = fakeSupabase({
      rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "White rice, cooked", catalog_food_id: null }],
    });
    await syncFoodPref(food(), client(hers));
    expect(readPrefRefCache(USER_ID)).toHaveProperty("white-rice");

    // The same browser, a different account: her ref ids are not this account's ref ids.
    // Identity now comes from the bound handle, not the Supabase client's claims (Phase 9 §0.1),
    // so the switch is simulated by binding the other account before the second call.
    const theirs = fakeSupabase({
      rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "White rice, cooked", catalog_food_id: null }],
    });
    expect(readPrefRefCache(OTHER_USER)).toEqual({});
    await resetTestAccount(OTHER_USER);
    await syncFoodPref(food(), client(theirs));
    // A fresh resolve against THIS account's row, not a short-circuit on hers.
    expect(theirs.rpcCalls).toEqual([
      { kind: "user", catalogFoodId: null, userFoodId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ]);
    expect(Object.keys(readPrefRefCache(USER_ID))).toEqual(["white-rice"]);
    expect(Object.keys(readPrefRefCache(OTHER_USER))).toEqual(["white-rice"]);
  });
});

describe("backfillFoodPrefs", () => {
  /** Zero-padded ids, so the id sort the backfill uses is the order these read in. */
  function many(n: number): Record<string, Food> {
    const out: Record<string, Food> = {};
    for (let i = 0; i < n; i += 1) {
      const id = `food-${String(i).padStart(2, "0")}`;
      out[id] = food({ id, name: `Food ${i}` });
    }
    return out;
  }

  it("syncs at most 20 foods a run and leaves the rest for the next one", async () => {
    const foods = many(53);
    const fake = fakeSupabase({ rows: [] });
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 20, skipped: 33 });
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 20, skipped: 13 });
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 13, skipped: 0 });
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(53);
    expect(await allOps(h)).toHaveLength(53);
    expect((await allOps(h)).every((op) => op.entity === "food_membership")).toBe(true);
  });

  it("overlapping callers take turns instead of colliding or collapsing", async () => {
    // The Foods tab mounts and SyncBootstrap finishes its first sync at the same moment, and
    // React strict mode double-invokes the effect. Nobody resolves the same food twice, and
    // nobody goes home with another caller's answer while work is still pending.
    const foods = many(53);
    const fake = fakeSupabase({ rows: [] });
    const results = await Promise.all([
      backfillFoodPrefs(h, foods, client(fake)),
      backfillFoodPrefs(h, foods, client(fake)),
      backfillFoodPrefs(h, foods, client(fake)),
    ]);
    expect(results.map((r) => r.synced).sort((a, b) => b - a)).toEqual([20, 20, 13]);
    const ops = await allOps(h);
    expect(ops).toHaveLength(53);
    expect(new Set(ops.map((o) => o.entity_id)).size).toBe(53);
    expect(fake.rpcCalls).toHaveLength(53);
  });

  it("a caller that arrives mid-run starts another one when work is left", async () => {
    const foods = many(53);
    const fake = fakeSupabase({ rows: [] });
    const first = backfillFoodPrefs(h, foods, client(fake));
    const second = backfillFoodPrefs(h, foods, client(fake));
    await Promise.all([first, second]);
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(40);
  });

  it("a waiter reads its OWN map, not the finished run's answer", async () => {
    // The run in flight empties its own backlog and reports `skipped: 0`. A waiter that took that
    // result home would never look at the food it was called with.
    const three = many(3);
    const four = many(4);
    const fake = fakeSupabase({ rows: [] });
    const running = backfillFoodPrefs(h, three, client(fake));
    const waiting = backfillFoodPrefs(h, four, client(fake));
    const [prior, mine] = await Promise.all([running, waiting]);

    expect(prior).toEqual({ synced: 3, skipped: 0 });
    expect(mine).toEqual({ synced: 1, skipped: 0 });
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(4);
    expect(readPrefRefCache(USER_ID)["food-03"]).toBeDefined();
  });

  it("a second account's run is not held up by the first account's stale run (Phase 9 §0.3)", async () => {
    // One account is bound at a time now: when the other account signs in, her run's handle goes
    // stale. Her parked run must not block theirs, and when it resumes it writes nothing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hers = fakeSupabase({ rows: [], beforeFirstRead: () => held });
    const theirs = fakeSupabase({ rows: [], userId: OTHER_USER });

    const running = backfillFoodPrefs(h, many(3), client(hers));
    await tick();
    const other = await resetTestAccount(OTHER_USER);
    await within(backfillFoodPrefs(other, many(2), client(theirs)), 2000,
      "the other account waited on a run that belongs to an account no longer bound");
    expect(Object.keys(readPrefRefCache(OTHER_USER))).toHaveLength(2);

    release();
    await running;
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(0);
    expect(hers.rpcCalls).toHaveLength(0);
  });

  it("never orphans a run when another account arrives mid-flight", async () => {
    // Her run is parked. Another account calls, and then she comes back and calls again. If the
    // other account's arrival dropped her run's in-flight entry, her second caller would see no run
    // to wait for and could resolve the same foods twice. Her three foods end with three ops.
    const three = many(3);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hers = fakeSupabase({ rows: [], beforeFirstRead: () => held });
    const theirs = fakeSupabase({ rows: [], userId: OTHER_USER });
    const herSecondCall = fakeSupabase({ rows: [] });

    const first = backfillFoodPrefs(h, three, client(hers));
    await tick();
    const other = await resetTestAccount(OTHER_USER);
    await backfillFoodPrefs(other, {}, client(theirs));
    const back = await resetTestAccount(USER_ID);
    const second = backfillFoodPrefs(back, three, client(herSecondCall));
    release();
    await Promise.all([first, second]);

    const ops = await allOps(back);
    expect(ops).toHaveLength(3);
    expect(new Set(ops.map((o) => o.entity_id)).size).toBe(3);
  });

  it("a waiter whose account changed while it waited does nothing", async () => {
    // She signs out, or a second account signs in, between the waiter queuing behind the run in
    // flight and its own turn arriving. Its pending list belongs to an account no longer bound
    // (Phase 9 §0.1): the waiter's own handle goes stale the moment the device binds elsewhere.
    const three = many(3);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hers = fakeSupabase({ rows: [], beforeFirstRead: () => held });
    const switching = fakeSupabase({ rows: [] });

    const running = backfillFoodPrefs(h, three, client(hers));
    await tick();
    const waiting = backfillFoodPrefs(h, three, client(switching));
    await tick();
    await resetTestAccount(OTHER_USER);
    release();
    const [, mine] = await Promise.all([running, waiting]);

    expect(mine).toEqual({ synced: 0, skipped: 3 });
    expect(switching.reads).toBe(0);
    expect(readPrefRefCache(OTHER_USER)).toEqual({});
  });

  it("does not multiply a failure-only backlog by the number of waiters", async () => {
    // Twenty foods that can never resolve. The first run learns that; the waiters must not each
    // spend another twenty lookups learning it again, because SyncBootstrap triggers on every sync.
    const foods = many(20);
    const fake = fakeSupabase({ rows: [], failNames: Object.values(foods).map((f) => f.name) });
    const results = await Promise.all([
      backfillFoodPrefs(h, foods, client(fake)),
      backfillFoodPrefs(h, foods, client(fake)),
      backfillFoodPrefs(h, foods, client(fake)),
    ]);
    expect(results).toEqual([
      { synced: 0, skipped: 20 }, { synced: 0, skipped: 20 }, { synced: 0, skipped: 20 },
    ]);
    expect(fake.reads).toBe(20);
  });

  it("forgets a failure once the food leaves her list, and on a change of account", async () => {
    const foods = many(3);
    const failing = fakeSupabase({ rows: [], failNames: Object.values(foods).map((f) => f.name) });
    await backfillFoodPrefs(h, foods, client(failing));
    expect(__backfillFailures()).toEqual(
      ["food-00", "food-01", "food-02"].map((id) => `${USER_ID}:${id}`));

    // She deletes two of them. The set only ever grew before; now the run drops what is gone.
    const kept = { "food-02": foods["food-02"] };
    const stillFailing = fakeSupabase({ rows: [], failNames: ["Food 2"] });
    await backfillFoodPrefs(h, kept, client(stillFailing));
    expect(__backfillFailures()).toEqual([`${USER_ID}:food-02`]);

    // A different account starts from nothing — her failures are not theirs.
    const theirs = fakeSupabase({ rows: [], userId: OTHER_USER });
    await backfillFoodPrefs(h, kept, client(theirs));
    expect(__backfillFailures()).toEqual([]);
  });

  it("a food that never resolves is sorted to the back, so it cannot starve the rest", async () => {
    // Twenty un-resolvable foods sort ahead of the five good ones. Without the failed set the
    // first run would take the same twenty for ever and the last five would never be reached.
    const foods = many(25);
    const stuck = Object.values(foods).slice(0, 20).map((f) => f.name);
    const fake = fakeSupabase({ rows: [], failNames: stuck });

    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 0, skipped: 25 });
    expect(await allOps(h)).toEqual([]);

    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 5, skipped: 20 });
    const cached = Object.keys(readPrefRefCache(USER_ID));
    expect(cached).toHaveLength(5);
    expect(cached.every((id) => Number(id.slice("food-".length)) >= 20)).toBe(true);
  });

  it("keeps picking up a food marked while the network was down", async () => {
    // The offline criterion: a mark made in airplane mode is retried on reconnect, however many
    // syncs later that is. A runner that stopped at "caught up" never looked again.
    const foods = many(53);
    const working = fakeSupabase({ rows: [] });
    for (let i = 0; i < 3; i += 1) await backfillFoodPrefs(h, foods, client(working));
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(53);

    const late = food({ id: "food-99", name: "Food 99" });
    const offline = fakeSupabase({ rows: [], failNames: ["Food 99"] });
    await syncFoodPref(late, client(offline));
    expect(readPrefRefCache(USER_ID)["food-99"]).toBeUndefined();

    const opsBefore = (await allOps(h)).length;
    const online = fakeSupabase({
      rows: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Food 99", catalog_food_id: 7 }],
    });
    expect(await backfillFoodPrefs(h, { ...foods, "food-99": late }, client(online)))
      .toEqual({ synced: 1, skipped: 0 });
    const ops = await allOps(h);
    expect(ops).toHaveLength(opsBefore + 1);
    expect(readPrefRefCache(USER_ID)["food-99"].catalogRefId).toBeDefined();
  });

  it("a run over an already-cached store touches nothing", async () => {
    const foods = many(3);
    const fake = fakeSupabase({ rows: [] });
    await backfillFoodPrefs(h, foods, client(fake));
    const rpcs = fake.rpcCalls.length;

    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 0, skipped: 0 });
    expect(fake.rpcCalls).toHaveLength(rpcs);
  });

  it("leaves an unresolvable food uncached so the next run retries it", async () => {
    // "Signed out" is now "no account bound" (Phase 9 §0.1): backfillFoodPrefs's own top-of-run
    // `isCurrent` check stops it cold, the way an unreachable claims read used to.
    const fake = fakeSupabase({});
    unbindAccount();
    expect(await backfillFoodPrefs(h, many(2), client(fake))).toEqual({ synced: 0, skipped: 2 });
    h = await resetTestAccount();
    expect(readPrefRefCache(USER_ID)).toEqual({});
  });

  it("caches under the documented localStorage key, namespaced by account", async () => {
    const fake = fakeSupabase({ rows: [] });
    await syncFoodPref(food(), client(fake));
    expect(FOOD_PREF_REFS_KEY).toBe("meal-companion:food-pref-refs");
    const blob = JSON.parse(localStorage.getItem(FOOD_PREF_REFS_KEY) ?? "{}");
    expect(blob[USER_ID]).toHaveProperty("white-rice");
  });
});

describe("the SyncBootstrap trigger", () => {
  function many(n: number): Record<string, Food> {
    const out: Record<string, Food> = {};
    for (let i = 0; i < n; i += 1) {
      const id = `food-${String(i).padStart(2, "0")}`;
      out[id] = food({ id, name: `Food ${i}` });
    }
    return out;
  }

  // SyncBootstrap's own effect cannot run under renderToStaticMarkup (this repo's only render
  // harness never runs effects), so the wiring is asserted at source level below and the behaviour
  // it triggers is asserted here. Neither half is faked.
  it("runs after every successful sync, and a full cache costs no RPC at all", async () => {
    const foods = many(53);
    const fake = fakeSupabase({ rows: [] });

    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 20, skipped: 33 });
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 20, skipped: 13 });
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 13, skipped: 0 });
    expect(Object.keys(readPrefRefCache(USER_ID))).toHaveLength(53);

    const rpcs = fake.rpcCalls.length;
    expect(await backfillFoodPrefs(h, foods, client(fake))).toEqual({ synced: 0, skipped: 0 });
    expect(fake.rpcCalls).toHaveLength(rpcs);
    expect(fake.reads).toBe(53);
  });

  it("is what SyncBootstrap calls after a successful sync (source-level)", () => {
    const bootstrap = readFileSync(
      path.join(process.cwd(), "components/SyncBootstrap.tsx"), "utf8");
    const accountSync = readFileSync(path.join(process.cwd(), "lib/sync/account-sync.ts"), "utf8");
    const postSync = readFileSync(path.join(process.cwd(), "lib/sync/post-sync.ts"), "utf8");
    // Since Phase 9 the bootstrap starts sync for the bound account through account-sync's
    // mountAccountSync, whose default run hands every successful sync to lib/sync/post-sync, which
    // runs this backfill beside the weigh-in drain. The wiring is three hops now; all three are
    // asserted.
    expect(bootstrap).toContain('import { mountAccountSync } from "@/lib/sync/account-sync"');
    expect(accountSync).toContain('import { syncThenCatchUp } from "./post-sync"');
    expect(accountSync).toMatch(/syncThenCatchUp\(h, \(\) => loadStore\(\)\.foods\)/);
    expect(postSync).toContain('import { backfillFoodPrefs } from "@/lib/foods/prefs-client"');
    expect(postSync).toMatch(/backfillFoodPrefs\(h, foods/);
    // No "run it once" flag: a mark made in airplane mode has to be picked up on a later sync.
    expect(bootstrap + accountSync + postSync).not.toMatch(/backfilled|caughtUp|makeSyncBackfill/);
  });
});
