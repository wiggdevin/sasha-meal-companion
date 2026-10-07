import { describe, expect, it, vi } from "vitest";
import {
  activeTargets, authorTargets, floorsFor, FloorViolationError, today,
  writeTargetRevisionSet,
} from "@/lib/server/targets";
import { defaultSettings } from "@/lib/store";
import type { TargetProfile } from "@/lib/api-types";

const PROFILE: TargetProfile = {
  id: "p1", user_id: "u1", effective_from: "2026-09-01", rev: 1,
  kcal_train: 2200, kcal_rest: 1750, authored_by: "user", mode: "grams",
  protein_g: 135, fat_g: 85, carb_g: 200, protein_pct: null, fat_pct: null,
  carb_pct: null, kcal_min: 1650, protein_g_min: 135, fat_g_min: 50,
  carb_g_min: 100, goal_rate_bp_week: 0, max_weekly_kcal_step: 150, notes: null,
};

function clientWith(profile: TargetProfile | null) {
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
      maybeSingle: async () => ({ data: { weight_kg: 60 }, error: null }),
    }) }) };
    return { select: () => ({ eq: () => ({ lte: () => ({ order: () => ({ order: () => ({
      limit: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }),
    }) }) }) }) }) };
  });
  return { client: { from, rpc } as never, rpc };
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
