// TDEE step E1 (docs/specs/phase-16-adaptive-handoff.md): the frozen formula seed survives every
// revision writer on a real database — derive, proposal approval, restore and a manual pin — and
// the expenditure engine reads it instead of the live profile.  [needs branch]
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUsers, HAS_BRANCH, resetUser } from "@/tests/helpers/supabase";
import { defaultSettings } from "@/lib/store";
import { authorTargets, restoreTargetRevision, writeDerivedTargets } from "@/lib/server/targets";
import { decideProposal } from "@/lib/server/proposals";
import { seedFor } from "@/lib/server/profile-tdee";
import type { Settings } from "@/lib/types";

const run = HAS_BRANCH ? describe : describe.skip;

// Ruling 2026-09-22 R4 persona: Mifflin 1,337.5 × 1.40 = 1,873.
const PERSONA: Settings = { ...defaultSettings(), sex: "female", birthYear: 1968, heightCm: 170,
  weightKg: 72.6, activityLevel: "moderate", goal: "recomp", goalRateBpWeek: 0 };
const SEED = { initial_tdee_kcal: 1873, bmr_kcal: 1338, bmr_method: "mifflin",
  activity_model_version: "activity-2026-09-22", derivation_version: "derive-2026-10-04" };
const SEED_COLUMNS = Object.keys(SEED).join(", ");

run("frozen target seed on a real database (step E1)", () => {
  let users: Awaited<ReturnType<typeof createTestUsers>>;
  let firstId = "";

  beforeAll(async () => {
    users = await createTestUsers();
    await resetUser(users.a.userId);
  });

  it("writes the seed on a derived revision and the engine reads it from there", async () => {
    const revision = await writeDerivedTargets(users.a.client, users.a.userId, {
      settings: PERSONA, latestWeighInKg: null, today: "2026-09-01", trainingWeekdays: [1, 3, 5],
    });
    firstId = revision.id as string;
    expect(revision.seed).toEqual({ initialTdeeKcal: 1873, bmrKcal: 1338, bmrMethod: "mifflin",
      activityModelVersion: "activity-2026-09-22", derivationVersion: "derive-2026-10-04" });
    // The live profile row says something else; the frozen seed wins.
    const live = await users.admin.from("user_settings").upsert({ user_id: users.a.userId,
      first_opened_at: "2026-09-01T00:00:00Z", sex: "female", birth_year: 1968, height_cm: 170,
      weight_kg: 90, activity_level: "very_active" });
    expect(live.error).toBeNull();
    expect(await seedFor(users.admin, users.a.userId, "2026-09-02"))
      .toEqual({ tdeeKcal: 1873, bmrKcal: 1338, source: "revision" });
  });

  it("carries the seed forward through a proposal approval", async () => {
    const { data } = await users.admin.from("target_proposals").insert({ user_id: users.a.userId,
      week_start: "2026-09-07", status: "pending", proposed: { kcalTrain: 2000, kcalRest: 1850,
        proteinG: 145, fatG: 55, carbG: 230, deltaKcalTrain: 40, deltaKcalRest: 40,
        raisedToFloor: false } }).select("id").single();
    await decideProposal(users.a.client, users.a.userId, data?.id as string,
      { decision: "approve", expectedStatus: "pending" });
    const approved = await users.admin.from("target_profiles").select(SEED_COLUMNS)
      .eq("user_id", users.a.userId).eq("authored_by", "engine_proposal").single();
    expect(approved.error).toBeNull();
    expect(approved.data).toEqual(SEED);
  });

  it("keeps the seed through restore and a manual pin", async () => {
    const restored = await restoreTargetRevision(users.a.client, users.a.userId, firstId,
      "2026-09-20");
    expect(restored.seed?.initialTdeeKcal).toBe(1873);
    await authorTargets(users.a.client, users.a.userId, { mode: "grams",
      effectiveFrom: "2026-09-21", kcalTrain: 2000, kcalRest: 1800,
      grams: { proteinG: 145, fatG: 60, carbG: 220 } });
    const manual = await users.admin.from("target_profiles").select(SEED_COLUMNS)
      .eq("user_id", users.a.userId).eq("effective_from", "2026-09-21").single();
    expect(manual.data).toEqual(SEED);
  });

  it("falls back to the live profile for a revision written before E1", async () => {
    const cleared = await users.admin.from("target_profiles").update({ initial_tdee_kcal: null })
      .eq("user_id", users.a.userId);
    expect(cleared.error).toBeNull();
    const seed = await seedFor(users.admin, users.a.userId, "2026-09-22");
    expect(seed?.source).toBe("live_profile");
    expect(seed?.tdeeKcal).not.toBe(1873);
  });
});
