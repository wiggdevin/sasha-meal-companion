// tests/targets/branch-cross-user.test.ts  — [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/store";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { authorTargets, FloorViolationError, writeDerivedTargets } from "@/lib/server/targets";

const run = HAS_BRANCH ? describe : describe.skip;

run("cross-user denial and percent authority on a real branch", () => {
  let admin: ReturnType<typeof adminClient>;
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  /** User A's own floor set — the only source of the numbers the authored write is checked against. */
  let floors: { proteinGMin: number; fatGMin: number };

  beforeAll(async () => {
    admin = adminClient();
    users = await createTestUsers();
    await resetUser(users.a.userId);
    await resetUser(users.b.userId);
    // D1 §5: the floor sequence reads the account's active revision and nothing
    // else — the ramp stage that used to supply 115 g of protein and 50 g of fat is deleted, and a
    // row-less account is refused with `targets_need_profile` (lib/server/targets.ts:195). Seed the
    // first revision through the same derived path onboarding uses, then assert against its floors.
    await writeDerivedTargets(users.a.client, users.a.userId, {
      settings: { ...defaultSettings(), sex: "female", birthYear: 1996, heightCm: 165,
        weightKg: 60, activityLevel: "moderate", goal: "recomp" },
      latestWeighInKg: null, today: "2026-09-11", trainingWeekdays: [1, 3, 4, 5],
    });
    const seeded = await admin.from("target_profiles").select("protein_g_min, fat_g_min")
      .eq("user_id", users.a.userId).single();
    expect(seeded.error).toBeNull();
    floors = { proteinGMin: Number(seeded.data?.protein_g_min),
      fatGMin: Number(seeded.data?.fat_g_min) };
    await admin.from("expenditure_estimates").insert({ user_id: users.a.userId,
      local_date: "2026-09-11", status: "estimating", tdee_kcal: 2250, confidence: 1,
      engine_version: "exp-1.0.0" });
    await admin.from("target_proposals").insert({ user_id: users.a.userId,
      week_start: "2026-10-05", status: "pending", proposed: {} });
  });

  it("shows user B nothing on either estimator table (criterion 13)", async () => {
    for (const table of ["expenditure_estimates", "target_proposals"]) {
      const { data } = await users.b.client.from(table).select("id");
      expect(data).toEqual([]);
    }
  });

  it("refuses user B's approve_target_proposal against user A's id", async () => {
    const { data, error } = await users.b.client.rpc("approve_target_proposal",
      { p_user_id: users.a.userId, p_proposal_id: "00000000-0000-0000-0000-000000000001" });
    expect(error ?? data).not.toEqual({ status: "approved" });
  });

  it("round-trips a percent profile server-side (criteria 10 and 11)", async () => {
    const out = await authorTargets(users.a.client, users.a.userId, { mode: "percent",
      effectiveFrom: "2026-09-14", kcalTrain: 2200, kcalRest: 1750,
      percent: { proteinPct: 31, fatPct: 30, carbPct: 39 } });
    const t = out.resolved.training;
    expect(Math.abs(4 * t.protein + 9 * t.fat + 4 * t.carbs - t.kcal)).toBeLessThanOrEqual(10);

    await expect(authorTargets(users.a.client, users.a.userId, { mode: "percent",
      effectiveFrom: "2026-09-15", kcalTrain: 2200, kcalRest: 1750,
      percent: { proteinPct: 40, fatPct: 20, carbPct: 40 } }))
      .rejects.toBeInstanceOf(FloorViolationError);
  });

  it("recomputes the floors even when the client sent post-floor numbers", async () => {
    await authorTargets(users.a.client, users.a.userId, { mode: "grams",
      effectiveFrom: "2026-09-16", kcalTrain: 2200, kcalRest: 1750,
      grams: { proteinG: 90, fatG: 30, carbG: 400 } });
    const { data } = await admin.from("target_profiles").select("protein_g, fat_g")
      .eq("user_id", users.a.userId).eq("effective_from", "2026-09-16").single();
    // Rewritten, not dropped: the literals 115 and >=50 were the deleted ramp's stage-1 floors.
    // The floors still recompute, from the account's own revision, so the sent 90 g and 30 g must
    // come back raised to that revision's floors.
    expect(floors.proteinGMin).toBeGreaterThan(90);
    expect(floors.fatGMin).toBeGreaterThan(30);
    expect(Number(data?.protein_g)).toBe(floors.proteinGMin);
    expect(Number(data?.fat_g)).toBe(floors.fatGMin);
  });
});
