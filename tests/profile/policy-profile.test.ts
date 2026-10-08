/**
 * Phase 13 slice 4 (§4, §9 R5): lib/server/policy-profile.ts — the one read that gives a coach turn
 * its constraint row plus its confirmed dietary-profile hard rules.
 */
import { describe, expect, it } from "vitest";
import { readPolicyProfile } from "@/lib/server/policy-profile";

type Result = { data: unknown; error: { code?: string } | null };

function client(tables: Record<string, Result>) {
  return {
    from: (table: string) => {
      const result = tables[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => result,
        then: (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve),
      });
      return chain;
    },
  } as never;
}

const ASOF = new Date("2026-09-25T00:00:00.000Z");
const item = (facet: string, confirmation: string) => ({
  id: `halal:${facet}`, profileId: "halal", facet, strength: "never", hardBasis: "religious",
  evidenceStrength: null, confirmation, expiresAt: null,
});

describe("readPolicyProfile", () => {
  it("carries only the confirmed hard rules of stored rows as profileRules", async () => {
    const { profile } = await readPolicyProfile(client({
      user_dietary_profiles: { data: [{
        profile_id: "halal", source: "user_stated", confirmed_at: "2026-09-24T00:00:00.000Z",
        rules: [item("pork", "confirmed"), item("alcohol", "unconfirmed")], options: {}, notes: null,
      }], error: null },
    }), "u1", ASOF);
    expect(profile.profileRules.items.map((rule) => rule.facet)).toEqual(["pork"]);
    expect(profile.profileRules.asOf).toBe(ASOF);
  });

  it("carries the account's profile ids so the pregnancy profile arms the tuna check (G7)", async () => {
    const { profile } = await readPolicyProfile(client({
      user_dietary_profiles: { data: [{
        profile_id: "pregnancy", source: "user_stated", confirmed_at: "2026-09-24T00:00:00.000Z",
        rules: [], options: {}, notes: null,
      }], error: null },
    }), "u1", ASOF);
    expect(profile.profileIds).toEqual(["pregnancy"]);
    expect(profile.conditions).toEqual([]);
    const { evaluatePolicy } = await import("@/lib/policy/constraints");
    const verdict = evaluatePolicy(profile, { foodRefId: null, allergenTags: null, category: null,
      onEatsList: false, onAvoidList: false, foodName: "Canned tuna", ingredientsText: "tuna, water" });
    expect(verdict.allergens?.some((finding) => finding.allergen === "tuna_mercury")).toBe(true);
  });

  /**
   * Owner ruling (2026-10-02): religious/user_rule profile hard rules fail safe. This test used to
   * pin the opposite — a missing `user_dietary_profiles` relation read as "no rules" — on the
   * theory that the table might not be migrated yet. The migration has shipped
   * (20261120090000_user_dietary_profiles.sql); a missing-table error now almost certainly means
   * something else is wrong (a bad connection string, a dropped grant), and treating it as "this
   * account has no hard rules" would silently clear a religious/safety rule it actually has. It
   * throws like every other read error now, the same as lib/server/recipe-candidates.ts already
   * does for this same table.
   */
  it("still fails when the dietary-profiles table is missing, not silently 'no rules'", async () => {
    await expect(readPolicyProfile(client({
      user_dietary_profiles: { data: null, error: { code: "42P01" } },
    }), "u1", ASOF)).rejects.toThrow(/dietary profiles/);
  });

  it("still fails on any other read error", async () => {
    await expect(readPolicyProfile(client({
      user_dietary_profiles: { data: null, error: { code: "57014" } },
    }), "u1", ASOF)).rejects.toThrow(/dietary profiles/);
  });
});
