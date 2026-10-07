import { describe, expect, it } from "vitest";
import { profileSeedFor, profileTdeeFor } from "@/lib/server/profile-tdee";

function clientWith(row: Record<string, unknown> | null) {
  const builder = {
    select: () => builder, eq: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { from: () => builder } as never;
}

const COMPLETE = { sex: "female", birth_year: 1996, height_cm: 165, weight_kg: 60,
  body_fat_pct: null, activity_level: "moderate" };

describe("profileSeedFor — the account's own prior and BMR (Devin, 2026-09-22)", () => {
  it("returns the Mifflin BMR and its activity-scaled TDEE for a complete profile", async () => {
    // Mifflin 1,320.25 → 1,320; × 1.40 = 1,848.35 → 1,848.
    await expect(profileSeedFor(clientWith(COMPLETE), "u1", "2026-09-19"))
      .resolves.toEqual({ tdeeKcal: 1848, bmrKcal: 1320 });
  });

  it("uses Katch-McArdle for a recent measured body fat", async () => {
    const seed = await profileSeedFor(clientWith({ ...COMPLETE, weight_kg: 57.64,
      body_fat_pct: 19.5, body_fat_source: "inbody", body_fat_measured_on: "2026-08-01" }),
    "u1", "2026-09-19");
    expect(seed?.bmrKcal).toBe(1372);
    expect(seed?.tdeeKcal).toBe(Math.round(1372.3 * 1.4));
  });

  it("uses Mifflin-St Jeor for a typed body fat, or a source it does not know", async () => {
    // Mifflin for 57.64 kg, 165 cm, age 30: 576.4 + 1031.25 - 150 - 161 = 1296.65.
    for (const provenance of [{}, { body_fat_source: "typed_unknown" },
      { body_fat_source: "guess", body_fat_measured_on: "2026-08-01" }]) {
      const seed = await profileSeedFor(clientWith({ ...COMPLETE, weight_kg: 57.64,
        body_fat_pct: 19.5, ...provenance }), "u1", "2026-09-19");
      expect(seed?.bmrKcal).toBe(1297);
    }
  });

  // Onboarding v2 "prefer not to say" (coordinator ruling 2026-10-06): unspecified is a complete
  // profile, not a missing one, and uses the midpoint sex term.
  it("accepts sex: 'unspecified' as a complete profile, at the midpoint BMR", async () => {
    const seed = await profileSeedFor(clientWith({ ...COMPLETE, sex: "unspecified" }),
      "u1", "2026-09-19");
    // Female (1320.25) + 83 (161 - 78) = 1403.25 -> 1403; male would be 1320.25 + 166 = 1486.25.
    expect(seed?.bmrKcal).toBe(1403);
  });

  it("returns null, never a borrowed number, when the profile is incomplete", async () => {
    await expect(profileSeedFor(clientWith(null), "u1", "2026-09-19")).resolves.toBeNull();
    await expect(profileSeedFor(clientWith({ ...COMPLETE, sex: null }), "u1", "2026-09-19"))
      .resolves.toBeNull();
    await expect(profileSeedFor(clientWith({ ...COMPLETE, activity_level: "hard" }), "u1",
      "2026-09-19")).resolves.toBeNull();
  });

  it("treats a zero weight or height, or an impossible body fat, as no profile", async () => {
    for (const row of [{ weight_kg: 0 }, { height_cm: 0 }, { weight_kg: -5 },
      { body_fat_pct: 100 }, { body_fat_pct: -1 }, { birth_year: 1800 }]) {
      await expect(profileSeedFor(clientWith({ ...COMPLETE, ...row }), "u1", "2026-09-19"),
        JSON.stringify(row)).resolves.toBeNull();
    }
  });

  it("keeps the display headline on the same number as the seed", async () => {
    await expect(profileTdeeFor(clientWith(COMPLETE), "u1", "2026-09-19")).resolves.toBe(1848);
  });
});
