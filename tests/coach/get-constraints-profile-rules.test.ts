/**
 * Phase 13 §4, §9 R5, owner ruling 2026-10-02: the coach's own `get_constraints` tool
 * (lib/server/coach-ports.ts) read the constraint row straight through `getProfile`, bypassing the
 * confirmed dietary-profile hard rules every other policy call site carries alongside it
 * (lib/server/policy-profile.ts readPolicyProfile) — so a model that called this tool mid-turn to
 * refresh its own picture of the account's rules never learned about a confirmed religious or
 * user_rule item at all.
 */
import { describe, expect, it, vi } from "vitest";
import { defaultPorts } from "@/lib/server/coach-ports";

vi.mock("@/lib/server/constraints", () => ({
  getProfile: vi.fn(async () => ({
    profile: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null },
    rev: 1, reviewRequired: false, reviewedAt: null,
  })),
}));
vi.mock("@/lib/server/dietary-profiles", () => ({
  readAccountProfileSets: vi.fn(async () => ({
    stored: [{
      profileId: "halal", source: "user_stated", confirmedAt: "2026-09-18T00:00:00.000Z",
      rules: [{
        id: "halal::pork", profileId: "halal", facet: "pork", strength: "never",
        hardBasis: "religious", evidenceStrength: "user_rule", confirmation: "confirmed",
        expiresAt: null,
      }],
      options: {},
    }],
    all: [],
  })),
}));

describe("defaultPorts().getConstraints", () => {
  it("carries the account's confirmed profile-rule facets, not just the constraint row", async () => {
    const client = {} as never;
    const ports = defaultPorts(client, client, () => "id-1", { tz: "UTC", date: "2026-09-20" });
    const constraints = await ports.getConstraints("u1") as
      { avoid_allergens: string[]; profileRules?: { items: readonly { facet: string }[] } };
    expect(constraints.avoid_allergens).toEqual(["peanut"]);
    expect(constraints.profileRules?.items.map((item) => item.facet)).toEqual(["pork"]);
  });
});
