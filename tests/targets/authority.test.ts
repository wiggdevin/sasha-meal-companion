import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDayContext } from "@/lib/server/day-context";
import { deriveTargetRevision } from "@/lib/profile/derive";
import {
  restoreTargetRevision, targetRevisionFromProfile, writeDerivedTargets,
} from "@/lib/server/targets";
import { defaultSettings } from "@/lib/store";
import {
  persistDerivedTargetRevision, restoreTargetRevisionOnline, settingsWithTargetRevision,
} from "@/lib/targets/client";
import { NO_HOLDS } from "@/lib/profile/rate-eligibility";
import { applyDerivedProfile, resolveTargets } from "@/lib/targets";
import type { TargetProfile } from "@/lib/api-types";
import type { Settings } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import { adminFake } from "@/tests/helpers/admin-fake";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", async () => (await import("@/tests/helpers/admin-fake")).adminModule);

/** The fake serves the reads and, as the service-role client, the target write RPCs. */
const asAdmin = <T>(client: T): never => { adminFake.client = client; return client as never; };

beforeEach(async () => {
  await resetTestAccount();
});

const EFFECTIVE_DATE = "2026-09-19";
const TRAINING_WEEKDAYS = [1, 3, 4, 5];

function completeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...defaultSettings(),
    sex: "female",
    birthYear: 1996,
    heightCm: 165,
    weightKg: 60,
    activityLevel: "moderate",
    goal: "recomp",
    trainingWeekdays: TRAINING_WEEKDAYS,
    ...overrides,
  };
}

const REVISION_ROW: TargetProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000010",
  effective_from: EFFECTIVE_DATE,
  rev: 4,
  kcal_train: 2200,
  kcal_rest: 1800,
  authored_by: "user",
  mode: "grams",
  protein_g: 120,
  fat_g: 80,
  carb_g: 250,
  protein_pct: null,
  fat_pct: null,
  carb_pct: null,
  kcal_min: 1200,
  protein_g_min: 120,
  fat_g_min: 50,
  carb_g_min: 0,
  goal_rate_bp_week: 0,
  max_weekly_kcal_step: 150,
  notes: null,
  target_source: "derived",
  training_macros: { kcal: 2200, protein: 120, carbs: 250, fat: 80 },
  rest_macros: { kcal: 1800, protein: 120, carbs: 150, fat: 80 },
  pin_training_kcal: null,
  pin_rest_kcal: null,
  pin_protein_g: null,
  input_weight_kg: 59.25,
  input_weight_source: "weigh-in",
  input_training_weekdays: TRAINING_WEEKDAYS,
  input_activity_level: "moderate",
  input_goal: "recomp",
  formula_name: "profile-energy-v1",
};

function contextDb(tables: Record<string, unknown[]>) {
  const api = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      lte: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => api(table) } as never;
}

describe("the target authority revision", () => {
  it("records the explicit date, weight provenance, weekdays, profile inputs and cleared pins", () => {
    const revision = deriveTargetRevision({
      settings: completeSettings(),
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
    });

    expect(revision).toMatchObject({
      source: "derived",
      revision: 1,
      effectiveFrom: EFFECTIVE_DATE,
      pins: { trainingKcal: null, restKcal: null, proteinG: null },
      inputs: {
        effectiveDate: EFFECTIVE_DATE,
        weightKg: 59.25,
        weightSource: "weigh-in",
        trainingWeekdays: TRAINING_WEEKDAYS,
        activity: "moderate",
        goal: "recomp",
        goalRateBpWeek: 0,
        formulaName: "profile-energy-v1",
      },
      floors: { kcalMin: 1326, kcalMinSource: "macro_minimum", proteinGMin: 119, fatGMin: 50,
        carbGMin: 100 },
    });
    expect(revision.training.protein).toBe(119);
    expect(revision.rest.protein).toBe(119);
  });

  it("writes the confirmed rate on the revision and derives at it (step D)", () => {
    const revision = deriveTargetRevision({
      settings: completeSettings({ goal: "lose_fat", goalRateBpWeek: -25 }),
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
    });
    const maintenance = deriveTargetRevision({
      settings: completeSettings({ goal: "lose_fat" }),
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
    });
    expect(revision.inputs.goalRateBpWeek).toBe(-25);
    // An account that never confirmed a rate derives at maintenance and says so.
    expect(maintenance.inputs.goalRateBpWeek).toBe(0);
    expect(revision.training.kcal).toBeLessThan(maintenance.training.kcal);
  });

  it("uses the cached revision byte-for-byte instead of deriving or applying pins again", () => {
    const cached = deriveTargetRevision({
      settings: completeSettings({ trainingKcal: 2300, proteinG: 140 }),
      latestWeighInKg: null,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
      source: "manual",
    });
    const settings = completeSettings({
      trainingKcal: cached.pins.trainingKcal,
      restKcal: cached.pins.restKcal,
      proteinG: cached.pins.proteinG,
      activeTargetProfile: cached,
    });

    expect(resolveTargets("training-10", settings)?.macros).toEqual(cached.training);
    expect(resolveTargets("rest", settings)?.macros).toEqual(cached.rest);
  });

  it("gives the phone and server day context the same authoritative targets", async () => {
    const revision = targetRevisionFromProfile(REVISION_ROW)!;
    const settings = settingsWithTargetRevision(completeSettings(), revision);
    const phone = resolveTargets("rest", settings)?.macros;
    const server = await buildDayContext(contextDb({
      days: [{ data: { date: EFFECTIVE_DATE } }],
      settings: [],
      user_settings: [{
        height_cm: 165,
        birth_year: 1996,
        sex: "female",
        weight_kg: 60,
        activity_level: "moderate",
        goal: "recomp",
        training_weekdays: TRAINING_WEEKDAYS,
      }],
      target_profiles: [REVISION_ROW],
      plan_days: [],
      foods: [],
      log_entries: [],
    }), REVISION_ROW.user_id, EFFECTIVE_DATE, "America/Denver");
    expect(server.targets).toEqual(phone);
  });

  it("lets explicit null pins clear a prior manual override", () => {
    const previous = completeSettings({ trainingKcal: 2300, restKcal: 1900, proteinG: 140 });
    const cleared = deriveTargetRevision({
      settings: { ...previous, trainingKcal: null, restKcal: null, proteinG: null },
      latestWeighInKg: null,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
      source: "manual",
    });

    expect(cleared.pins).toEqual({ trainingKcal: null, restKcal: null, proteinG: null });
    expect(cleared.training.protein).not.toBe(140);
  });

  it("returns no target for an incomplete profile", () => {
    expect(resolveTargets("training-10", defaultSettings())).toBeNull();
  });

  it("makes applyDerivedProfile delegate to the same revision service", () => {
    const settings = completeSettings();
    const applied = applyDerivedProfile(
      settings,
      new Date(`${EFFECTIVE_DATE}T12:00:00.000Z`),
      59.25,
      TRAINING_WEEKDAYS,
    );
    const direct = deriveTargetRevision({
      settings,
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
    });

    // The preview carries no revision number, so `resolveTargets` stays null
    // until the server assigns one (design §5.4).
    const { revision: _revision, id: _id, ...candidate } = direct;
    expect(applied.activeTargetProfile).toEqual(candidate);
    expect(resolveTargets("training-10", applied)).toBeNull();
  });

  it("maps the database row into the exact synchronized cache contract", () => {
    expect(targetRevisionFromProfile(REVISION_ROW)).toEqual({
      id: REVISION_ROW.id,
      revision: 4,
      source: "derived",
      effectiveFrom: EFFECTIVE_DATE,
      training: REVISION_ROW.training_macros,
      rest: REVISION_ROW.rest_macros,
      pins: { trainingKcal: null, restKcal: null, proteinG: null },
      inputs: {
        effectiveDate: EFFECTIVE_DATE,
        weightKg: 59.25,
        weightSource: "weigh-in",
        trainingWeekdays: TRAINING_WEEKDAYS,
        activity: "moderate",
        goal: "recomp",
        goalRateBpWeek: 0,
        formulaName: "profile-energy-v1",
      },
      // A row written before kcal_min_source existed reads as the legacy default.
      floors: { kcalMin: 1200, kcalMinSource: "legacy_default", proteinGMin: 120, fatGMin: 50,
        carbGMin: 0 },
      // A row written before step E1 has no frozen seed; the engine uses the live profile.
      seed: null,
    });
  });

  it("maps a frozen seed only when all five columns are present (step E1)", () => {
    const seeded = { ...REVISION_ROW, initial_tdee_kcal: 1873, bmr_kcal: 1338,
      bmr_method: "mifflin" as const, activity_model_version: "activity-2026-09-22",
      derivation_version: "derive-2026-10-04" };
    expect(targetRevisionFromProfile(seeded)?.seed).toEqual({ initialTdeeKcal: 1873,
      bmrKcal: 1338, bmrMethod: "mifflin", activityModelVersion: "activity-2026-09-22",
      derivationVersion: "derive-2026-10-04" });
    expect(targetRevisionFromProfile({ ...seeded, bmr_method: null })?.seed).toBeNull();
    expect(targetRevisionFromProfile({ ...seeded, initial_tdee_kcal: null })?.seed).toBeNull();
  });

  it("maps a stored rate and minimum source losslessly (step D)", () => {
    const revision = targetRevisionFromProfile({ ...REVISION_ROW, goal_rate_bp_week: -50,
      input_goal: "lose_fat", kcal_min_source: "macro_minimum" });
    expect(revision?.inputs.goalRateBpWeek).toBe(-50);
    expect(revision?.floors?.kcalMinSource).toBe("macro_minimum");
  });

  it("does not let a backdated revision replace a later effective cache", () => {
    const current = targetRevisionFromProfile({
      ...REVISION_ROW,
      id: "00000000-0000-4000-8000-000000000002",
      rev: 5,
      effective_from: "2026-09-20",
    })!;
    // An injected today, so the case never depends on the wall clock.
    const today = "2026-10-05";
    const settings = settingsWithTargetRevision(completeSettings(), current, today);
    const backdated = targetRevisionFromProfile(REVISION_ROW)!;
    const next = settingsWithTargetRevision(settings, backdated, today);

    // The later revision stays current; the backdated one only joins the dated history.
    expect(next.activeTargetProfile).toBe(settings.activeTargetProfile);
    expect(next.targetHistory?.map((r) => r.effectiveFrom)).toEqual([EFFECTIVE_DATE, "2026-09-20"]);
    expect(settingsWithTargetRevision(next, backdated, today)).toBe(next);
  });

  it("persists derivation through write_target_revision and returns the assigned revision", async () => {
    const rpc = vi.fn(async () => ({ data: REVISION_ROW, error: null }));
    const result = await writeDerivedTargets(asAdmin({ rpc }), REVISION_ROW.user_id, {
      settings: completeSettings(),
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
      source: "derived",
      eligibility: NO_HOLDS,
    });

    expect(rpc).toHaveBeenCalledWith("write_target_revision", {
      p_user_id: REVISION_ROW.user_id,
      p_row: expect.objectContaining({
        target_source: "derived",
        effective_from: EFFECTIVE_DATE,
        input_weight_kg: 59.25,
        input_weight_source: "weigh-in",
        training_macros: expect.any(Object),
        rest_macros: expect.any(Object),
        goal_rate_bp_week: 0,
        kcal_min: 1326,
        kcal_min_source: "macro_minimum",
        protein_g_min: 119,
        fat_g_min: 50,
        carb_g_min: 100,
      }),
    });
    expect(result.revision).toBe(4);
  });

  it("stores the account's macro minimum, never a 1,500 kcal male floor (step D)", async () => {
    const rpc = vi.fn(async () => ({ data: { ...REVISION_ROW,
      input_weight_source: "onboarding", input_weight_kg: 80 }, error: null }));
    await writeDerivedTargets(asAdmin({ rpc }), REVISION_ROW.user_id, {
      settings: completeSettings({ sex: "male", weightKg: 80, goal: "lose_fat",
        goalRateBpWeek: -50 }),
      latestWeighInKg: null,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
      source: "derived",
      eligibility: NO_HOLDS,
    });

    // 80 kg at 165 cm: protein basis 30 × 1.65² = 81.7 → 80 kg → 160 g; 640 + 450 + 400.
    expect(rpc).toHaveBeenCalledWith("write_target_revision", expect.objectContaining({
      p_row: expect.objectContaining({ kcal_min: 1490, kcal_min_source: "macro_minimum",
        goal_rate_bp_week: -50, fat_g_min: 50, carb_g_min: 100 }),
    }));
  });

  it("undo copies the selected prior row through the same revision RPC", async () => {
    // The stored rate and minimum source survive restore and Undo (step D).
    const priorRow = { ...REVISION_ROW, goal_rate_bp_week: -50, input_goal: "lose_fat" as const,
      kcal_min_source: "macro_minimum" as const };
    const restoredRow = { ...priorRow, id: "00000000-0000-4000-8000-000000000002", rev: 5 };
    const maybeSingle = vi.fn(async () => ({ data: priorRow, error: null }));
    const rpc = vi.fn(async () => ({ data: restoredRow, error: null }));
    // The eligibility read (lib/server/target-eligibility.ts) sees an account with no holds.
    const noAnswers = { select: () => ({ eq: () => Object.assign(
      Promise.resolve({ data: [], error: null }),
      { maybeSingle: async () => ({ data: null, error: null }) }) }) };
    const client = {
      from: (table: string) => table === "target_profiles"
        ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) } : noAnswers,
      rpc,
    } as never;
    asAdmin(client);

    const result = await restoreTargetRevision(
      client,
      REVISION_ROW.user_id,
      REVISION_ROW.id,
      "2026-09-20",
    );

    expect(rpc).toHaveBeenCalledWith("write_target_revision", expect.objectContaining({
      p_user_id: REVISION_ROW.user_id,
      p_row: expect.objectContaining({
        target_source: "derived",
        training_macros: REVISION_ROW.training_macros,
        pin_training_kcal: null,
        kcal_min: REVISION_ROW.kcal_min,
        kcal_min_source: "macro_minimum",
        goal_rate_bp_week: -50,
        protein_g_min: REVISION_ROW.protein_g_min,
        fat_g_min: REVISION_ROW.fat_g_min,
        carb_g_min: REVISION_ROW.carb_g_min,
      }),
    }));
    expect(result).toMatchObject({ revision: 5, training: REVISION_ROW.training_macros,
      inputs: { goalRateBpWeek: -50 } });
  });

  it("uses one client endpoint for writes and mirrors the returned macros and pins", async () => {
    const revision = targetRevisionFromProfile(REVISION_ROW)!;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      id: revision.id,
      mode: "grams",
      raisedToFloor: false,
      resolved: { training: revision.training, rest: revision.rest },
      revision,
    }));
    const base = completeSettings();
    const persisted = await persistDerivedTargetRevision({
      settings: base,
      latestWeighInKg: 59.25,
      today: EFFECTIVE_DATE,
      trainingWeekdays: TRAINING_WEEKDAYS,
      source: "derived",
    }, fetchImpl);
    const cached = settingsWithTargetRevision(base, persisted);

    expect(fetchImpl).toHaveBeenCalledWith("/api/targets", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"operation":"derive"'),
    }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      settings: { trainingKcal: null, restKcal: null, proteinG: null },
    });
    expect(cached.activeTargetProfile).toEqual(revision);
    expect(cached).toMatchObject({ trainingKcal: null, restKcal: null, proteinG: null });
  });

  it("restores through the same client endpoint", async () => {
    const revision = targetRevisionFromProfile(REVISION_ROW)!;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      id: revision.id,
      mode: "grams",
      raisedToFloor: false,
      resolved: { training: revision.training, rest: revision.rest },
      revision,
    }));
    await restoreTargetRevisionOnline(REVISION_ROW.id, "2026-09-20", fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      operation: "restore",
      revisionId: REVISION_ROW.id,
      effectiveFrom: "2026-09-20",
    });
  });
});
