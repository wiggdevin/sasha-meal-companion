/**
 * Phase 18 W2b, acceptance 4 (phone half): a rule changed on another device moves the server's
 * token, so the next new-suggestion request refetches its admission, and an admission stamped with
 * the old token is never used. Offline, no new suggestion is made (owner question 6).
 */
import { describe, expect, it, vi } from "vitest";
import { freshness, parseRulesToken, sameRulesToken, type RulesToken } from "@/lib/foods/world/freshness";
import { freshAdmission } from "@/lib/foods/world/rules-version-client";

const t = (rulesVersion: number, evidenceVersion = 1): RulesToken => ({ rulesVersion, evidenceVersion });
type Held = { token: RulesToken | null; ids: string[] };

describe("the freshness token", () => {
  it("parses only two non-negative integer counters", () => {
    expect(parseRulesToken({ rulesVersion: 3, evidenceVersion: 0 })).toEqual(t(3, 0));
    for (const bad of [null, {}, { rulesVersion: "3", evidenceVersion: 1 }, { rulesVersion: -1, evidenceVersion: 1 },
      { rulesVersion: 1.5, evidenceVersion: 1 }, { rulesVersion: 1 }]) expect(parseRulesToken(bad)).toBeNull();
  });

  it("is fresh only when both counters match, and never offline", () => {
    expect(freshness(t(4), t(4))).toEqual({ fresh: true });
    expect(freshness(t(4), t(5))).toEqual({ fresh: false, reason: "stale" });
    expect(freshness(t(4, 1), t(4, 2))).toEqual({ fresh: false, reason: "stale" });
    expect(freshness(t(4), null)).toEqual({ fresh: false, reason: "offline" });
    expect(freshness(null, t(4))).toEqual({ fresh: false, reason: "unstamped" });
    expect(sameRulesToken(null, null)).toBe(false);
  });
});

describe("freshAdmission (W2b acceptance 4)", () => {
  const held: Held = { token: t(4), ids: ["bread"] };

  it("reuses the held admission while the server still reports its token", async () => {
    const refetch = vi.fn();
    expect(await freshAdmission(held, { readToken: async () => t(4), refetch })).toBe(held);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches after a rule change on another device and uses the new admission", async () => {
    const next: Held = { token: t(5), ids: [] };
    const refetch = vi.fn(async () => next);
    expect(await freshAdmission(held, { readToken: async () => t(5), refetch })).toBe(next);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("admits nothing under the old revision: a refetch still stamped with it is refused", async () => {
    const stale: Held = { token: t(4), ids: ["bread"] };
    expect(await freshAdmission(held, { readToken: async () => t(5), refetch: async () => stale })).toBeNull();
  });

  it("accepts a refetch computed under a newer token only when that token is current", async () => {
    const tokens = [t(5), t(6)];
    const newer: Held = { token: t(6), ids: [] };
    expect(await freshAdmission(held, { readToken: async () => tokens.shift() ?? t(6), refetch: async () => newer }))
      .toBe(newer);
    const moving = [t(5), t(7)];
    expect(await freshAdmission(held, { readToken: async () => moving.shift() ?? t(7), refetch: async () => newer }))
      .toBeNull();
  });

  it("makes no new suggestion offline or when the refetch fails", async () => {
    expect(await freshAdmission(held, { readToken: async () => null, refetch: async () => held })).toBeNull();
    expect(await freshAdmission(held, { readToken: async () => t(5),
      refetch: async () => { throw new Error("409 rules_changed"); } })).toBeNull();
    expect(await freshAdmission(null, { readToken: async () => null, refetch: async () => held })).toBeNull();
  });
});
