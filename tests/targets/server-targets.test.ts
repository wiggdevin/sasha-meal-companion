import { describe, expect, it, vi } from "vitest";
import { adminFake } from "@/tests/helpers/admin-fake";

vi.mock("@/lib/server/admin", async () => (await import("@/tests/helpers/admin-fake")).adminModule);
import {
  activeTargets, authorTargets, floorsFor, FloorViolationError, today,
  writeTargetRevisionSet,
} from "@/lib/server/targets";
import { defaultSettings } from "@/lib/store";
import { AdultOnlyError, SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";
import type { TargetProfile } from "@/lib/api-types";

const PROFILE: TargetProfile = {
  id: "p1", user_id: "u1", effective_from: "2026-09-01", rev: 1,
  kcal_train: 2200, kcal_rest: 1750, authored_by: "user", mode: "grams",
  protein_g: 135, fat_g: 85, carb_g: 200, protein_pct: null, fat_pct: null,
  carb_pct: null, kcal_min: 1650, protein_g_min: 135, fat_g_min: 50,
  carb_g_min: 100, goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null,
};

/** The account's stored safety answers the eligibility read sees (lib/server/target-eligibility.ts). */
type Answers = { conditions?: readonly string[];
  profiles?: readonly { profile_id: string; source: string }[]; birthYear?: number | null };

function clientWith(profile: TargetProfile | null, answers: Answers = {}) {
  const rpc = vi.fn(async (_name: string, args: { p_row?: Record<string, unknown> }) => ({
    data: {
      ...PROFILE, id: "p2", rev: 2, target_source: args.p_row?.target_source,
      training_macros: args.p_row?.training_macros, rest_macros: args.p_row?.rest_macros,
      pin_training_kcal: args.p_row?.pin_training_kcal,
      pin_rest_kcal: args.p_row?.pin_rest_kcal, pin_protein_g: args.p_row?.pin_protein_g,
      input_weight_kg: args.p_row?.input_weight_kg,
      input_weight_source: args.p_row?.input_weight_source,
      input_training_weekdays: args.p_row?.input_training_weekdays,
      input_activity_level: args.p_row?.input_activity_level,
      input_goal: args.p_row?.input_goal, formula_name: args.p_row?.formula_name,
    }, error: null,
  }));
  const from = vi.fn((table: string) => {
    if (table === "user_settings") return { select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { weight_kg: 60, birth_year: answers.birthYear ?? 1990 },
        error: null }),
    }) }) };
    if (table === "constraint_profiles") return { select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: answers.conditions ? { conditions: answers.conditions } : null,
        error: null }),
    }) }) };
    if (table === "user_dietary_profiles") return { select: () => ({
      eq: async () => ({ data: answers.profiles ?? [], error: null }),
    }) };
    return { select: () => ({ eq: () => ({ lte: () => ({ order: () => ({ order: () => ({
      limit: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }),
    }) }) }) }) }) };
  });
  const client = { from, rpc } as never;
  adminFake.client = client;
  return { client, rpc };
}

describe("target authority", () => {
  it("uses UTC as the neutral fallback date", () => {
    expect(today(new Date("2026-09-13T01:00:00.000Z"))).toBe("2026-09-13");
  });

  it("returns null rather than inventing a target without a revision", async () => {
    const { client } = clientWith(null);
    await expect(activeTargets(client, "u1")).resolves.toBeNull();
    await expect(floorsFor(client, "u1")).rejects.toMatchObject({
      status: 409, code: "targets_need_profile",
    });
  });

  it("reads targets and floors only from the effective revision", async () => {
    const { client } = clientWith(PROFILE);
    const target = await activeTargets(client, "u1");
    expect(target?.resolved.training).toEqual({ kcal: 2200, protein: 135, carbs: 224, fat: 85 });
    await expect(floorsFor(client, "u1")).resolves.toEqual({
      kcalMin: 1650, proteinGMin: 135, fatGMin: 50, carbGMin: 100,
    });
  });

  it("writes a derived revision through the authority RPC", async () => {
    const { client, rpc } = clientWith(null);
    const settings = { ...defaultSettings(), sex: "female" as const, birthYear: 1996,
      heightCm: 165, weightKg: 60, activityLevel: "moderate" as const,
      goal: "recomp" as const, trainingWeekdays: [1, 3, 4, 5] };
    await writeTargetRevisionSet(client, "u1", {
      operation: "derive", input: { settings, latestWeighInKg: 60,
        today: "2026-09-19", trainingWeekdays: [1, 3, 4, 5] },
    });
    expect(rpc).toHaveBeenCalledWith("write_target_revision", expect.objectContaining({
      p_user_id: "u1", p_row: expect.objectContaining({ formula_name: "profile-energy-v1" }),
    }));
  });
});

describe("manual target authoring", () => {
  it("requires an effective revision instead of using global fallback floors", async () => {
    const { client } = clientWith(null);
    await expect(authorTargets(client, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750,
      grams: { proteinG: 135, fatG: 85, carbG: 200 } })).rejects.toMatchObject({
      status: 409, code: "targets_need_profile",
    });
  });

  it("keeps the active revision's rate and minimum source on a manual row (step D)", async () => {
    const { client, rpc } = clientWith({ ...PROFILE, goal_rate_bp_week: -50,
      kcal_min_source: "macro_minimum" });
    await authorTargets(client, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, grams: { proteinG: 135, fatG: 85, carbG: 200 } });
    expect(rpc).toHaveBeenCalledWith("write_target_revision", expect.objectContaining({
      p_row: expect.objectContaining({ goal_rate_bp_week: -50, kcal_min_source: "macro_minimum" }),
    }));
  });

  it("labels a manual row built on a pre-D revision as legacy_default", async () => {
    const { client, rpc } = clientWith(PROFILE);
    await authorTargets(client, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, grams: { proteinG: 135, fatG: 85, carbG: 200 } });
    expect(rpc).toHaveBeenCalledWith("write_target_revision", expect.objectContaining({
      p_row: expect.objectContaining({ goal_rate_bp_week: 0, kcal_min_source: "legacy_default" }),
    }));
  });

  it("re-applies revision floors and reports percent violations", async () => {
    const { client } = clientWith(PROFILE);
    await expect(authorTargets(client, "u1", { mode: "percent", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750,
      percent: { proteinPct: 20, fatPct: 30, carbPct: 50 } }))
      .rejects.toBeInstanceOf(FloorViolationError);
  });
});

describe("pace holds on every server write (onboarding v2 G1-G3)", () => {
  const loseSettings = (over: Record<string, unknown> = {}) => ({ ...defaultSettings(),
    sex: "female" as const, birthYear: 1990, heightCm: 165, weightKg: 80,
    activityLevel: "light" as const, goal: "lose_fat" as const, goalRateBpWeek: -50,
    trainingWeekdays: [1, 3], ...over });
  const derive = (settings: ReturnType<typeof loseSettings>, today = "2026-10-08") => ({
    operation: "derive" as const,
    input: { settings, latestWeighInKg: null, today, trainingWeekdays: [1, 3] },
  });
  const row = (rpc: ReturnType<typeof vi.fn>) =>
    (rpc.mock.calls.at(-1)?.[1] as { p_row: Record<string, unknown> }).p_row;

  it("keeps a chosen loss pace when the account has no hold", async () => {
    const { client, rpc } = clientWith(null);
    await writeTargetRevisionSet(client, "u1", derive(loseSettings()));
    expect(row(rpc).goal_rate_bp_week).toBe(-50);
  });

  for (const [label, answers] of [
    ["pregnant (tap)", { conditions: [SAFETY_CONDITION_TEXT.pregnant] }],
    ["breastfeeding (tap)", { conditions: [SAFETY_CONDITION_TEXT.breastfeeding] }],
    ["a clinician-set diet (tap)", { conditions: [SAFETY_CONDITION_TEXT.clinicianDiet] }],
    ["an eating disorder (free text)", { conditions: ["in recovery from anorexia"] }],
    ["kidney disease (free text)", { conditions: ["stage 3 kidney disease"] }],
    ["the pregnancy profile", { profiles: [{ profile_id: "pregnancy", source: "user_stated" }] }],
    ["the lactation profile", { profiles: [{ profile_id: "lactation", source: "user_stated" }] }],
    ["the ED recovery profile",
      { profiles: [{ profile_id: "eating_disorder_recovery", source: "user_stated" }] }],
    ["a clinician-directed profile",
      { profiles: [{ profile_id: "vegan", source: "clinician_directed_per_user" }] }],
  ] as const) {
    it(`derives at a 0 pace for ${label}, whatever the client sent`, async () => {
      const { client, rpc } = clientWith(null, answers as Answers);
      for (const rate of [-25, -50, -75]) {
        await writeTargetRevisionSet(client, "u1", derive(loseSettings({ goalRateBpWeek: rate })));
        expect(row(rpc).goal_rate_bp_week).toBe(0);
      }
      const { client: gain, rpc: gainRpc } = clientWith(null, answers as Answers);
      await writeTargetRevisionSet(gain, "u1",
        derive(loseSettings({ goal: "gain_muscle", goalRateBpWeek: 25 })));
      expect(row(gainRpc).goal_rate_bp_week).toBe(0);
    });
  }

  it("gives kidney disease standard protein (0.8 g/kg), not the high-protein factor", async () => {
    const { client, rpc } = clientWith(null);
    await writeTargetRevisionSet(client, "u1", derive(loseSettings()));
    expect((row(rpc).training_macros as { protein: number }).protein).toBe(160); // 80 kg × 2.0
    const { client: kidney, rpc: kidneyRpc } = clientWith(null, { conditions: ["dialysis"] });
    await writeTargetRevisionSet(kidney, "u1", derive(loseSettings()));
    expect((row(kidneyRpc).training_macros as { protein: number }).protein).toBe(64); // 80 × 0.8
    expect(row(kidneyRpc).protein_g_min).toBe(64);
    expect(row(kidneyRpc).goal_rate_bp_week).toBe(0);
  });

  it("builds no plan for an account under 18 on the revision's date", async () => {
    const { client, rpc } = clientWith(null);
    await expect(writeTargetRevisionSet(client, "u1",
      derive(loseSettings({ birthYear: 2009 }), "2026-10-08"))).rejects.toBeInstanceOf(AdultOnlyError);
    expect(rpc).not.toHaveBeenCalled();
    // 18 this year is an adult, by the same year arithmetic the formula uses.
    await writeTargetRevisionSet(client, "u1", derive(loseSettings({ birthYear: 2008 })));
    expect(rpc).toHaveBeenCalledTimes(1);
    const { client: profiled, rpc: profiledRpc } = clientWith(null,
      { profiles: [{ profile_id: "minor_under_18", source: "user_stated" }] });
    await expect(writeTargetRevisionSet(profiled, "u1", derive(loseSettings())))
      .rejects.toBeInstanceOf(AdultOnlyError);
    expect(profiledRpc).not.toHaveBeenCalled();
  });

  it("holds the pace on a pinned (authored) revision and refuses a minor's pins", async () => {
    const { client, rpc } = clientWith({ ...PROFILE, goal_rate_bp_week: -50 },
      { conditions: [SAFETY_CONDITION_TEXT.pregnant] });
    await authorTargets(client, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, grams: { proteinG: 135, fatG: 85, carbG: 200 },
      goalRateBpWeek: -75 });
    expect(row(rpc).goal_rate_bp_week).toBe(0);
    const { client: minor, rpc: minorRpc } = clientWith(PROFILE, { birthYear: 2010 });
    await expect(authorTargets(minor, "u1", { mode: "grams", effectiveFrom: "2026-09-14",
      kcalTrain: 2200, kcalRest: 1750, grams: { proteinG: 135, fatG: 85, carbG: 200 } }))
      .rejects.toBeInstanceOf(AdultOnlyError);
    expect(minorRpc).not.toHaveBeenCalled();
  });

  it("fails closed when the health answers cannot be read", async () => {
    const { client, rpc } = clientWith(null);
    const failing = { ...(client as object), from: (table: string) => table === "constraint_profiles"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null,
        error: { message: "down" } }) }) }) }
      : (client as unknown as { from: (t: string) => unknown }).from(table), rpc } as never;
    await expect(writeTargetRevisionSet(failing, "u1", derive(loseSettings())))
      .rejects.toMatchObject({ status: 503, code: "eligibility_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
