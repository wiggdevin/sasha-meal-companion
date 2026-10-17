/** W047 (d): the next instant a confirmed hard rule changes its verdict with no token move. */
import { describe, expect, it } from "vitest";
import { nextRuleBoundary } from "@/lib/policy/profiles/rule-boundary";
import type { ProfileInstance, RuleItem } from "@/lib/policy/profiles/types";

const NOW = new Date("2026-10-17T12:00:00Z");
const item = (over: Partial<RuleItem>): RuleItem => ({ id: "r" as RuleItem["id"], profileId: "p", facet: "meat",
  strength: "never", hardBasis: "religious", evidenceStrength: null,
  confirmation: "confirmed", expiresAt: null, ...over });
const instance = (...rules: RuleItem[]): ProfileInstance => ({ profileId: "p", source: "user_stated",
  confirmedAt: "2026-10-01T00:00:00Z", rules, options: {} });

describe("nextRuleBoundary", () => {
  it("is null with no dated rule", () => {
    expect(nextRuleBoundary([], NOW)).toBeNull();
    expect(nextRuleBoundary([instance(item({}))], NOW)).toBeNull();
  });

  it("takes the earliest future window start, window end or expiry", () => {
    const fasting = item({ window: "calendar", activeWindows: [
      { start: "2026-10-17T05:00:00Z", end: "2026-10-17T18:00:00Z" },
      { start: "2026-10-18T05:00:00Z", end: "2026-10-18T18:00:00Z" }] });
    const course = item({ expiresAt: "2026-10-20T00:00:00Z" });
    expect(nextRuleBoundary([instance(fasting, course)], NOW)?.toISOString()).toBe("2026-10-17T18:00:00.000Z");
    expect(nextRuleBoundary([instance(course)], NOW)?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  it("ignores rules that can never block: soft, unconfirmed or without a hard basis", () => {
    const at = { expiresAt: "2026-10-18T00:00:00Z" };
    expect(nextRuleBoundary([instance(item({ ...at, strength: "avoid" }),
      item({ ...at, confirmation: "unconfirmed" }), item({ ...at, hardBasis: null }))], NOW))
      .toBeNull();
  });

  it("answers undefined for a date it cannot read, so the route sends no boundary and nothing is cached", () => {
    expect(nextRuleBoundary([instance(item({ expiresAt: "not a date" }))], NOW)).toBeUndefined();
    expect(nextRuleBoundary([instance(item({ expiresAt: "2026-10-18T00:00:00Z" }),
      item({ expiresAt: "not a date" }))], NOW)).toBeUndefined();
  });
});
