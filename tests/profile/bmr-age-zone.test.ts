/**
 * Audit A005: the Mifflin age reads the UTC year of the effective instant (noon UTC), so a phone
 * at UTC+13 and the server freeze the same BMR seed for the same revision.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bmr, type EnergyProfile } from "@/lib/profile/energy";

const PROFILE = { sex: "female", birthYear: 1990, heightCm: 165, weightKg: 60,
  activityLevel: "moderate", goal: "recomp", goalRateBpWeek: 0 } as EnergyProfile;

describe("BMR age across zones", () => {
  let savedTz: string | undefined;
  beforeEach(() => { savedTz = process.env.TZ; });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("is the same on Dec 31 at noon UTC in Auckland (already Jan 1 there) and in UTC", () => {
    const effective = new Date("2026-12-31T12:00:00Z");
    process.env.TZ = "UTC";
    const utc = bmr(PROFILE, effective);
    process.env.TZ = "Pacific/Auckland";
    expect(bmr(PROFILE, effective)).toBe(utc);
    // Age 36 in 2026: 600 + 1031.25 - 180 - 161.
    expect(utc).toBe(1290.25);
  });
});
