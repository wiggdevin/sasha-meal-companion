/**
 * Phase 18 W11 (docs/specs/phase-18-open-world-foods.md §W11, D7): the actual Supabase reads and
 * writes behind `set_shopping_focus` — `tests/server/shopping-focus-route.test.ts` mocks this
 * whole module away, so the query construction itself (which column, which table, the period
 * lookup's filters) had no coverage of its own.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getShoppingFocusUntil, resolveFocusEnd, setShoppingFocusUntil,
} from "@/lib/server/shopping-focus";
import { FOCUS_MAX_DAYS, maxFocusEnd } from "@/lib/shopping/focus";
import { localDate } from "@/lib/recipes-hub/put-in-meal";

const USER_ID = "00000000-0000-4000-8000-000000000001";

/** A fake `user_settings` + `shopping_periods` client, in the hand-rolled style
 *  `tests/server/constraints-condition-column.test.ts` already uses for this codebase. */
function client(options: {
  settingsRow?: { shopping_focus_until: string | null } | null;
  settingsError?: { code: string; message: string } | null;
  periodRow?: { end_date: string } | null;
  periodError?: { code: string; message: string } | null;
} = {}): { client: SupabaseClient; updates: Record<string, unknown>[]; periodFilters: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = [];
  const periodFilters: Record<string, unknown>[] = [];
  const from = (table: string) => {
    if (table === "user_settings") {
      return {
        select: () => ({ eq: () => ({
          maybeSingle: async () => options.settingsError
            ? { data: null, error: options.settingsError }
            : { data: options.settingsRow ?? null, error: null },
        }) }),
        update: (values: Record<string, unknown>) => ({ eq: async () => {
          updates.push(values);
          return { error: null };
        } }),
      };
    }
    if (table === "shopping_periods") {
      const filters: Record<string, unknown> = {};
      const query = {
        eq: (col: string, value: unknown) => { filters[col] = value; return query; },
        lte: (col: string, value: unknown) => { filters[col] = value; return query; },
        gte: (col: string, value: unknown) => { filters[col] = value; return query; },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => {
          periodFilters.push(filters);
          return options.periodError ? { data: null, error: options.periodError }
            : { data: options.periodRow ?? null, error: null };
        },
      };
      return { select: () => query };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { client: { from } as unknown as SupabaseClient, updates, periodFilters };
}

describe("getShoppingFocusUntil", () => {
  it("returns null when the row has never been set", async () => {
    expect(await getShoppingFocusUntil(client().client, USER_ID)).toBeNull();
  });
  it("returns the stored value", async () => {
    const fake = client({ settingsRow: { shopping_focus_until: "2026-10-12T00:00:00.000Z" } });
    expect(await getShoppingFocusUntil(fake.client, USER_ID)).toBe("2026-10-12T00:00:00.000Z");
  });
  it("throws on a real read error", async () => {
    const fake = client({ settingsError: { code: "57014", message: "timeout" } });
    await expect(getShoppingFocusUntil(fake.client, USER_ID)).rejects.toThrow();
  });
});

describe("setShoppingFocusUntil", () => {
  it("writes the new value and returns the one it replaced", async () => {
    const fake = client({ settingsRow: { shopping_focus_until: "2026-10-05T00:00:00.000Z" } });
    const previous = await setShoppingFocusUntil(fake.client, USER_ID, "2026-10-12T00:00:00.000Z");
    expect(previous).toBe("2026-10-05T00:00:00.000Z");
    expect(fake.updates).toEqual([{ shopping_focus_until: "2026-10-12T00:00:00.000Z" }]);
  });
  it("writing null (turning focus off) is a real write, not a skip", async () => {
    const fake = client({ settingsRow: { shopping_focus_until: "2026-10-05T00:00:00.000Z" } });
    await setShoppingFocusUntil(fake.client, USER_ID, null);
    expect(fake.updates).toEqual([{ shopping_focus_until: null }]);
  });
});

describe("resolveFocusEnd", () => {
  const now = new Date("2026-10-05T00:00:00.000Z");

  it("with explicit days, never queries shopping_periods at all", async () => {
    const fake = client({ periodRow: { end_date: "2026-10-20" } });
    const resolved = await resolveFocusEnd(fake.client, USER_ID, now, 3);
    expect(resolved).toBe(new Date(now.getTime() + 3 * 86_400_000).toISOString());
    expect(fake.periodFilters).toHaveLength(0);
  });

  it("clamps an explicit days request past FOCUS_MAX_DAYS to the max", async () => {
    const fake = client();
    const resolved = await resolveFocusEnd(fake.client, USER_ID, now, FOCUS_MAX_DAYS + 10);
    expect(resolved).toBe(maxFocusEnd(now));
  });

  it("with no days and an open period, queries it filtered to today (the device's own zone) and takes its end date", async () => {
    const fake = client({ periodRow: { end_date: "2026-10-12" } });
    const resolved = await resolveFocusEnd(fake.client, USER_ID, now);
    expect(resolved).toBe("2026-10-12T23:59:59.999Z");
    const today = localDate(now);
    expect(fake.periodFilters[0]).toEqual({ user_id: USER_ID, start_date: today, end_date: today });
  });

  it("with no days and no open period, falls back to the 7-day default", async () => {
    const fake = client({ periodRow: null });
    const resolved = await resolveFocusEnd(fake.client, USER_ID, now);
    expect(resolved).toBe(new Date(now.getTime() + 7 * 86_400_000).toISOString());
  });

  it("clamps a period end far past FOCUS_MAX_DAYS to the max", async () => {
    const fake = client({ periodRow: { end_date: "2026-12-01" } });
    const resolved = await resolveFocusEnd(fake.client, USER_ID, now);
    expect(resolved).toBe(maxFocusEnd(now));
  });

  it("throws on a real shopping_periods read error", async () => {
    const fake = client({ periodError: { code: "57014", message: "timeout" } });
    await expect(resolveFocusEnd(fake.client, USER_ID, now)).rejects.toThrow();
  });
});
