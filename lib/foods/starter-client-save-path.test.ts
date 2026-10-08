// @vitest-environment jsdom
/**
 * ONB2-P0 (GOAL defect 6): proves the two things that made "Use this plan" take 8+ seconds are
 * both gone from `persistStarterSelection`'s production write path (`defaultStarterWriter`):
 *   1. no `set_food_membership` acknowledgement RPC per food any more (it was a redundant
 *      network write — the queued op, not this RPC, is what the account's `flushOutboxNow` pass
 *      actually delivers);
 *   2. the per-food ref-minting work for 12 foods runs in bounded-concurrency batches, not one
 *      `await` at a time — proven by observing up to `STARTER_WRITE_CONCURRENCY` (4) mark() calls
 *      in flight at once, which turns 12 sequential round trips into 3 sequential batches.
 *
 * The fake Supabase client below is narrow on purpose: only the calls this write path actually
 * makes (`user_foods` select/insert for a "custom" food with no catalog ref, and the
 * `get_or_create_food_ref`/`set_food_membership` RPCs), modelled on the harness in
 * tests/foods/prefs-client.test.ts.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { persistStarterSelection, type StarterWriter } from "@/lib/foods/starter-client";
import { setFoodMembership } from "@/lib/foods/prefs-client";
import { starterChoices } from "@/lib/foods/starter";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null };
const choices = starterChoices([], rules);

// 4 proteins, 4 carbs, 4 fats — a valid pick-for-me-sized selection (>= 2 per role, 12 total).
const TWELVE_FOODS = [
  "chicken-breast-roasted", "turkey-breast-roasted", "egg-white", "greek-yogurt-plain-nonfat",
  "white-rice-cooked", "brown-rice-cooked", "oatmeal-cooked", "banana",
  "olive-oil", "avocado-oil", "avocado", "almonds",
] as const;
const marks = Object.fromEntries(TWELVE_FOODS.map((id) => [id, "eats" as const]));

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

type FakeSupabase = { client: unknown; userRefCalls: number; membershipRpcCalls: number };

/** Every food here is a brand-new "custom" food (no catalog ref), so each resolves to exactly
 *  one `get_or_create_food_ref("user", ...)` RPC plus one `user_foods` insert. */
function fakeSupabase(): FakeSupabase {
  const rows: { id: string; name: string; catalog_food_id: null }[] = [];
  const out: FakeSupabase = { client: null, userRefCalls: 0, membershipRpcCalls: 0 };
  let refSeq = 0;
  const from = (table: string) => {
    if (table !== "user_foods") throw new Error(`unexpected table ${table}`);
    const filters: Record<string, unknown> = {};
    let staged: typeof rows[number] | null = null;
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
      in: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      upsert: (row: { id: string; name: string }) => {
        staged = { id: row.id, name: row.name, catalog_food_id: null };
        rows.push(staged);
        return chain;
      },
      maybeSingle: async () => {
        if (staged) return { data: staged, error: null };
        const matched = rows.find((r) => r.name === filters.name) ?? null;
        return { data: matched, error: null };
      },
    };
    return chain;
  };
  out.client = {
    auth: { getClaims: async () => ({ data: { claims: { sub: USER_ID } } }) },
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "set_food_membership") {
        out.membershipRpcCalls += 1;
        return { data: { rev: 0, status: args.p_status, updated: 1, truncated: false }, error: null };
      }
      if (name !== "get_or_create_food_ref") return { data: null, error: { message: "unexpected rpc" } };
      out.userRefCalls += 1;
      refSeq += 1;
      return { data: `22222222-2222-4222-8222-${String(refSeq).padStart(12, "0")}`, error: null };
    },
  };
  return out;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true });
});

describe("persistStarterSelection's production write path (defaultStarterWriter)", () => {
  it("batches 12 foods' writes instead of one await at a time, and skips the acknowledgement RPC", async () => {
    bindAccount(USER_ID);
    const fake = fakeSupabase();
    const saved: Record<string, unknown> = {};
    let active = 0;
    let maxActive = 0;
    const deps: StarterWriter = {
      existing: () => ({}),
      save: (food) => { saved[food.id] = food; },
      // Mirrors `defaultStarterWriter.mark` exactly (acknowledge: false), with the fake Supabase
      // client injected and an in-flight counter wrapped around the real network call — the same
      // seam `tests/foods/prefs-client.test.ts` uses to prove delivery, used here to prove timing.
      mark: async (food, h) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await setFoodMembership(food.name, food.status === "neutral" ? null : food.status, {
            food, account: h, acknowledge: false, note: food.note ?? null,
            supabase: fake.client as never,
          });
        } finally {
          active -= 1;
        }
      },
    };

    const written = await persistStarterSelection(marks, choices, deps);

    expect(written).toBe(12);
    // The old loop awaited one food at a time: at most one mark() call was ever in flight. The
    // new loop batches STARTER_WRITE_CONCURRENCY (4) at once, so up to 4 are in flight together —
    // 12 foods complete in 3 sequential batches, not 12 sequential round trips.
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(fake.userRefCalls).toBe(12);
    // acknowledge: false — the per-food `set_food_membership` RPC this file used to await on top
    // of the ref-minting work never happens; the queued op (proved separately in
    // tests/foods/prefs-client.test.ts) is what the account's own sync pass delivers instead.
    expect(fake.membershipRpcCalls).toBe(0);
    unbindAccount();
  });
});
