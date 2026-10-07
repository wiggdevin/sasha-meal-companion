/**
 * Phase 13 slice 4: readAccountProfileInstances' legacy-flag synthesis is deterministic — the
 * synthesized confirmedAt is the settings row's own stored time, never the wall clock of the read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  legacyBackedProfileIds, readAccountProfileInstances, readStoredProfileInstances,
} from "@/lib/server/dietary-profiles";

type Result = { data: unknown; error: null };

function client(tables: Record<string, Result>) {
  return {
    from: (table: string) => {
      const result = tables[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, maybeSingle: async () => result,
        then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
      });
      return chain;
    },
  } as never;
}

const settings = (changedAt: string | null) => ({ user_settings: { data: {
  diet_prefs: { flags: ["halal"] }, changed_at: changedAt, onboarded_at: null,
}, error: null }, user_dietary_profiles: { data: [], error: null } });

afterEach(() => vi.useRealTimers());

describe("readAccountProfileInstances", () => {
  it("dates a synthesized legacy instance from the settings row, identically on every read", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-09-25T10:00:00.000Z"));
    const first = await readAccountProfileInstances(client(settings("2026-09-01T00:00:00.000Z")), "u1");
    vi.setSystemTime(new Date("2026-09-25T11:00:00.000Z"));
    const second = await readAccountProfileInstances(client(settings("2026-09-01T00:00:00.000Z")), "u1");
    expect(first[0].confirmedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(second).toEqual(first);
  });

  it("uses a fixed epoch, not the clock, when the row carries no time at all", async () => {
    const [instance] = await readAccountProfileInstances(client(settings(null)), "u1");
    expect(instance.confirmedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("legacyBackedProfileIds", () => {
  it("names the profiles the account's legacy flags keep active", async () => {
    expect([...await legacyBackedProfileIds(client(settings(null)), "u1")]).toEqual(["halal"]);
  });
});

/**
 * Owner ruling (2026-10-02): a stored row's `rules` column used to silently become `[]` whenever
 * it was not an array — a corrupt or partially-written row read as "this profile instance has no
 * hard rules," the same silent-pass-through the missing-table fallback above gave up. It throws
 * instead: a profile instance whose rules cannot be read cannot be proven to have none.
 */
describe("readStoredProfileInstances", () => {
  it("fails when a stored row's rules column is not an array", async () => {
    const rows = [{
      profile_id: "halal", source: "user_stated", confirmed_at: "2026-09-24T00:00:00.000Z",
      rules: "not-an-array", options: {}, notes: null,
    }];
    await expect(readStoredProfileInstances(
      client({ user_dietary_profiles: { data: rows, error: null } }), "u1",
    )).rejects.toThrow();
  });
});
