/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11, D7): the server reads and the
 * service-role write/Undo behind shopping focus. The fake client records every filter, so the
 * soft-delete, owner and account-day filters (Sol W11 r1 WARN 1) are checked, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const rpc = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc: rpc.fn }) }));

const {
  focusRankingFor, readShoppingFocusState, resolveFocusEnd, setShoppingFocus, undoShoppingFocus,
} = await import("@/lib/server/shopping-focus");
const { maxFocusEnd } = await import("@/lib/shopping/focus");

const USER_ID = "00000000-0000-4000-8000-000000000001";

type Call = { table: string; ops: [string, ...unknown[]][] };

/** A chainable fake: `rows[table]` answers every select of that table; every call is recorded. */
function fake(rows: Record<string, unknown[] | Record<string, unknown> | null>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const answer = () => {
        const data = rows[table] ?? null;
        return { data, error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "lte", "gte", "in", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return builder; };
      }
      builder.range = (...args: unknown[]) => {
        call.ops.push(["range", ...args]);
        const data = rows[table];
        return Promise.resolve({ data: Array.isArray(data) ? data : [], error: null });
      };
      builder.maybeSingle = () => {
        call.ops.push(["maybeSingle"]);
        const data = rows[table];
        return Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data ?? null, error: null });
      };
      builder.then = (resolve: (value: unknown) => unknown) => resolve(answer());
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const has = (call: Call | undefined, ...op: unknown[]) =>
  call?.ops.some((entry) => JSON.stringify(entry) === JSON.stringify(op)) ?? false;

const DAY = { date: "2026-10-05", zone: "America/Los_Angeles" };
const NOW = new Date("2026-10-05T18:00:00.000Z");

beforeEach(() => rpc.fn.mockReset());

describe("resolveFocusEnd: the account's day, live periods only", () => {
  it("looks up the open period on the account's day and never a deleted one", async () => {
    // Two lists cover the day: the current-list rule (lib/shopping/current.ts) picks the later start.
    const { client, calls } = fake({ shopping_periods: [
      { start_date: "2026-10-01", end_date: "2026-10-20", updated_at: "2026-10-01T00:00:00Z" },
      { start_date: "2026-10-03", end_date: "2026-10-09", updated_at: "2026-10-02T00:00:00Z" }] });
    const end = await resolveFocusEnd(client, USER_ID, NOW, DAY);
    const call = calls.find((entry) => entry.table === "shopping_periods");
    expect(has(call, "is", "deleted_at", null)).toBe(true);
    expect(has(call, "eq", "user_id", USER_ID)).toBe(true);
    expect(has(call, "lte", "start_date", "2026-10-05")).toBe(true);
    expect(has(call, "gte", "end_date", "2026-10-05")).toBe(true);
    // The period's last local moment in the account's zone (PDT, UTC-7).
    expect(end).toBe("2026-10-10T06:59:59.999Z");
  });

  it("falls back to 7 days, and clamps an explicit `days` at 31 days", async () => {
    const { client } = fake({ shopping_periods: null });
    expect(await resolveFocusEnd(client, USER_ID, NOW, DAY))
      .toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    expect(await resolveFocusEnd(client, USER_ID, NOW, DAY, 31)).toBe(maxFocusEnd(NOW));
  });
});

describe("readShoppingFocusState", () => {
  it("reads nothing past the settings row while focus is off", async () => {
    const { client, calls } = fake({ user_settings: { shopping_focus_until: null } });
    expect(await readShoppingFocusState(client, USER_ID, DAY, NOW)).toEqual({ until: null, keys: [] });
    expect(calls.map((call) => call.table)).toEqual(["user_settings"]);
  });

  it("keys checked, window-checked and manual lines and pantry; drops deleted rows and past boxes", async () => {
    const { client, calls } = fake({
      user_settings: { shopping_focus_until: "2026-10-12T06:59:59.999Z" },
      shopping_periods: [{ id: "p1", start_date: "2026-10-01", end_date: "2026-10-04" },
        { id: "p0", start_date: "2026-09-20", end_date: "2026-09-28" }],
      shopping_lines: [
        { id: "l1", period_id: "p1", name: "Rice", checked: true, origin: "plan" },
        { id: "l2", period_id: "p1", name: "Chicken breast", checked: false, origin: "plan" },
        { id: "l3", period_id: "p1", name: "Tofu", checked: false, origin: "plan" },
        { id: "l4", period_id: "p0", name: "Old beans", checked: true, origin: "manual" },
      ],
      shopping_purchase_windows: [{ line_id: "l2" }],
      shopping_pantry: [{ name: "Oats", confirmed_at: "2026-10-03T03:00:00.000Z" }],
    });
    const state = await readShoppingFocusState(client, USER_ID, DAY, NOW);
    expect(state.keys).toEqual([
      { key: "chicken breast", from: "2026-10-01", to: "2026-10-07" },
      { key: "oats", from: "2026-10-02", to: "2026-10-16" },
      { key: "rice", from: "2026-10-01", to: "2026-10-07" },
    ]);
    for (const table of ["shopping_periods", "shopping_lines", "shopping_purchase_windows", "shopping_pantry"]) {
      const call = calls.find((entry) => entry.table === table);
      expect(has(call, "is", "deleted_at", null), table).toBe(true);
      expect(has(call, "eq", "user_id", USER_ID), table).toBe(true);
    }
    expect(has(calls.find((entry) => entry.table === "shopping_purchase_windows"), "eq", "checked", true)).toBe(true);
  });

  it("drops a pantry row set to 0 g, keeps one with no amount, and keeps the 14-day box (W024)", async () => {
    const { client, calls } = fake({
      user_settings: { shopping_focus_until: "2026-10-12T06:59:59.999Z" }, shopping_periods: [],
      shopping_pantry: [
        { name: "Rice", confirmed_at: "2026-10-03T03:00:00.000Z", confirmed_grams: 0 },
        { name: "Pasta", confirmed_at: "2026-10-03T03:00:00.000Z", confirmed_grams: "0" },
        { name: "Oats", confirmed_at: "2026-10-03T03:00:00.000Z", confirmed_grams: null },
        { name: "Beans", confirmed_at: "2026-10-03T03:00:00.000Z", confirmed_grams: "250.5" },
      ],
    });
    const state = await readShoppingFocusState(client, USER_ID, DAY, NOW);
    expect(state.keys).toEqual([
      { key: "beans", from: "2026-10-02", to: "2026-10-16" },
      { key: "oats", from: "2026-10-02", to: "2026-10-16" },
    ]);
    expect(has(calls.find((entry) => entry.table === "shopping_pantry"), "select",
      "name,confirmed_at,confirmed_grams")).toBe(true);
  });
});

describe("focusRankingFor", () => {
  it("is undefined, reading nothing, for an account without Shopping access", async () => {
    vi.stubEnv("RECIPE_PLANNING_USER_IDS", "someone-else");
    const { client, calls } = fake({ user_settings: { shopping_focus_until: "2026-10-12T00:00:00.000Z" } });
    expect(await focusRankingFor(client, USER_ID, "2026-10-05", NOW)).toBeUndefined();
    expect(calls).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("ranks by the keys of the asked date for an account with access", async () => {
    vi.stubEnv("RECIPE_PLANNING_USER_IDS", USER_ID);
    const { client } = fake({
      user_settings: { shopping_focus_until: "2026-10-12T06:59:59.999Z", time_zone: "America/Los_Angeles" },
      shopping_periods: [], shopping_pantry: [{ name: "Oats", confirmed_at: "2026-10-03T03:00:00.000Z" }],
    });
    const focus = await focusRankingFor(client, USER_ID, "2026-10-05", NOW);
    expect(focus?.coverageOf([{ key: "oats", kcal: 100 }])).toBe(1);
    vi.unstubAllEnvs();
  });
});

describe("setShoppingFocus / undoShoppingFocus (service role, compare-and-set)", () => {
  it("sends only the session user and the server-decided end", async () => {
    rpc.fn.mockResolvedValue({ data: { status: "applied", actionId: "a1", until: "x", previous: null }, error: null });
    expect(await setShoppingFocus(USER_ID, "2026-10-12T00:00:00.000Z"))
      .toEqual({ actionId: "a1", until: "x", previous: null });
    expect(rpc.fn).toHaveBeenCalledWith("shopping_focus_set",
      { p_user_id: USER_ID, p_until: "2026-10-12T00:00:00.000Z" });
  });

  it("answers 409 when the account has no settings row", async () => {
    rpc.fn.mockResolvedValue({ data: { status: "no_settings" }, error: null });
    await expect(setShoppingFocus(USER_ID, null)).rejects.toMatchObject({ status: 409 });
  });

  it("reports a superseded Undo, and an undone one", async () => {
    rpc.fn.mockResolvedValueOnce({ data: { status: "superseded", until: "later" }, error: null });
    expect(await undoShoppingFocus(USER_ID, "a1")).toEqual({ status: "superseded", until: "later" });
    rpc.fn.mockResolvedValueOnce({ data: { status: "undone", until: null }, error: null });
    expect(await undoShoppingFocus(USER_ID, "a1")).toEqual({ status: "undone", until: null });
    expect(rpc.fn).toHaveBeenLastCalledWith("shopping_focus_undo", { p_user_id: USER_ID, p_action_id: "a1" });
  });
});
