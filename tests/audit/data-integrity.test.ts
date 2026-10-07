import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTargetRevision, TARGET_FORMULA_NAME } from "@/lib/profile/derive";
import type { Settings } from "@/lib/types";
import {
  exitCode, foodRefDanglingIds, foodRefUnusedIds, healthRangeIds, markdown,
  membershipContradictionsFromRows, parseArgs, planAvoidIds, profileRangeIds,
  reportChecksum, reportDate, reportPath, rlsDisabledIds,
  targetMismatches, type Finding,
} from "@/scripts/audit/data-integrity";

const originalUrl = process.env.SUPABASE_URL;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
});

const settings = {
  user_id: "00000000-0000-4000-8000-000000000001",
  first_opened_at: "2026-09-01T12:00:00.000Z",
  training_kcal: null, rest_kcal: null, protein_g: null,
  height_cm: 165, birth_year: 1990, sex: "female" as const, body_fat_pct: 25,
  weight_kg: 60, activity_level: "moderate" as const, goal: "recomp" as const,
  training_weekdays: [1, 3, 4, 5], diet_prefs: { flags: [] },
  onboarded_at: "2026-09-19T12:00:00.000Z",
};

function profile(): Settings {
  return {
    trainingKcal: null, restKcal: null, proteinG: null, proteinLocked: true,
    slotTimes: {}, shiftMinutes: 0, changedAt: null,
    heightCm: 165, birthYear: 1990, sex: "female", bodyFatPct: 25, weightKg: 60,
    activityLevel: "moderate", goal: "recomp", trainingWeekdays: [1, 3, 4, 5],
    dietPrefs: null, onboardedAt: settings.onboarded_at,
  };
}

function target(kcalDelta = 0) {
  const derived = deriveTargetRevision({ settings: profile(), latestWeighInKg: null,
    today: "2026-09-19", trainingWeekdays: [1, 3, 4, 5], source: "derived" });
  return {
    id: "00000000-0000-4000-8000-000000000002", user_id: settings.user_id,
    effective_from: "2026-09-19", rev: 1, target_source: "derived" as const,
    training_macros: { ...derived.training, kcal: derived.training.kcal + kcalDelta },
    rest_macros: derived.rest, pin_training_kcal: null, pin_rest_kcal: null,
    pin_protein_g: null, input_weight_kg: 60, input_weight_source: "onboarding" as const,
    input_training_weekdays: [1, 3, 4, 5], input_activity_level: "moderate" as const,
    input_goal: "recomp" as const, formula_name: TARGET_FORMULA_NAME,
  };
}

describe("data-integrity audit classifiers", () => {
  it("flags one profile row for migration-range and shape violations", () => {
    expect(profileRangeIds([settings, { ...settings, user_id: "bad", weight_kg: 19,
      training_weekdays: [1, 1], diet_prefs: [] }])).toEqual(["bad"]);
  });

  it("uses the recorded target effective date and one-unit tolerance", () => {
    expect(targetMismatches([settings], [target()])).toEqual([]);
    expect(targetMismatches([settings], [target(1)])).toEqual([]);
    expect(targetMismatches([settings], [target(2)]).map((row) => row.userId))
      .toEqual([settings.user_id]);
    expect(targetMismatches([settings], []).map((row) => row.userId))
      .toEqual([settings.user_id]);
  });

  it("flags settings-to-authority drift, null macros, and unavailable U1 columns", () => {
    expect(targetMismatches([{ ...settings, training_kcal: 1_900 }], [target()])
      .map((row) => row.userId)).toEqual([settings.user_id]);
    expect(targetMismatches([settings], [{ ...target(), input_goal: "maintain" }])
      .map((row) => row.userId)).toEqual([settings.user_id]);
    expect(targetMismatches([settings], [target()], new Map([[settings.user_id, 59]]))
      .map((row) => row.userId)).toEqual([settings.user_id]);
    expect(targetMismatches([settings], [{ ...target(), training_macros: null }])
      .map((row) => row.userId)).toEqual([settings.user_id]);
    expect(targetMismatches([settings], [], new Map(), false)
      .map((row) => `${row.userId}:${row.reason}`))
      .toEqual([`${settings.user_id}:u1_columns_unavailable`]);
  });

  it("counts a stored slot once when any normalized component is on Avoid", () => {
    const avoids = new Map([[settings.user_id,
      { refs: new Set(["avoid-ref"]), names: new Set(["watermelon"]) }]]);
    const rows = [{ user_id: settings.user_id, local_date: "2026-09-19",
      item_overrides: { "meal-1": { components: [
        { name: "Watermelon, raw" }, { name: "WATERMELON, seedless" },
      ] }, "meal-2": { components: [{ name: "rice" }] } } }];
    expect(planAvoidIds(rows, avoids)).toEqual([`${settings.user_id}:2026-09-19:meal-1`]);
  });

  it("walks swaps, item overrides, components, and extras, preferring food refs over names", () => {
    const avoids = new Map([[settings.user_id,
      { refs: new Set(["avoid-ref"]), names: new Set(["watermelon"]) }]]);
    const rows = [{ user_id: settings.user_id, local_date: "2026-09-19",
      swaps: {
        coffee: { food_ref_id: "avoid-ref", name: "coffee" },
        "meal-1": { food_ref_id: "safe-ref", name: "watermelon" },
      },
      item_overrides: {
        "meal-2": { components: [{ name: "Watermelon, raw" }] },
        "meal-3": { items: [{ foodRefId: "avoid-ref", name: "rice" }] },
      },
      extras: [{ id: "extra-1", items: [{ food_ref_id: "avoid-ref", name: "rice" }] }],
    }];
    expect(planAvoidIds(rows, avoids)).toEqual([
      `${settings.user_id}:2026-09-19:coffee`,
      `${settings.user_id}:2026-09-19:meal-2`,
      `${settings.user_id}:2026-09-19:meal-3`,
      `${settings.user_id}:2026-09-19:extra-1`,
    ]);
  });

  it("reports only refs whose target row is missing as dangling", () => {
    const refs = [
      { id: "missing-catalog", kind: "catalog" as const, catalog_food_id: 2, user_food_id: null },
      { id: "missing-user", kind: "user" as const, catalog_food_id: null, user_food_id: "food-2" },
      { id: "valid-unused", kind: "catalog" as const, catalog_food_id: 1, user_food_id: null },
    ];
    expect(foodRefDanglingIds(refs, new Set(["food-1"]), new Set([1])))
      .toEqual(["missing-catalog", "missing-user"]);
  });

  it("reports only valid refs without a consumer as unused", () => {
    const refs = [
      { id: "dangling", kind: "catalog" as const, catalog_food_id: 2, user_food_id: null },
      { id: "unused", kind: "catalog" as const, catalog_food_id: 1, user_food_id: null },
      { id: "used", kind: "catalog" as const, catalog_food_id: 1, user_food_id: null },
    ];
    expect(foodRefUnusedIds(refs, new Set(), new Set([1]), new Set(["used"])))
      .toEqual(["unused"]);
  });

  it("falls back to the U3 normalized-name contradiction rule when the RPC is not deployed", () => {
    const prefs = [
      { user_id: "u", food_ref_id: "a", status: "eats" as const,
        updated_at: "2026-09-18T00:00:00Z" },
      { user_id: "u", food_ref_id: "b", status: "avoid" as const,
        updated_at: "2026-09-19T00:00:00Z" },
    ];
    const rows = membershipContradictionsFromRows(prefs,
      new Map([["a", "watermelon"], ["b", "watermelon"]]));
    expect(rows).toMatchObject([{ user_id: "u", name_norm: "watermelon", row_count: 2,
      eats_updated_at: "2026-09-18T00:00:00Z", avoid_updated_at: "2026-09-19T00:00:00Z" }]);
  });

  it("converts legacy weight units and treats more than ten litres as out of range", () => {
    const health = [
      { id: "ok-lb", value: 132, unit: "lb" },
      { id: "low-kg", value: 19, unit: "kg" },
      { id: "unknown", value: 60, unit: "stone" },
    ];
    const water = [
      { user_id: "u", local_date: "2026-09-18", cups: 41 },
      { user_id: "u", local_date: "2026-09-19", cups: 42 },
    ];
    expect(healthRangeIds(health, water)).toEqual(["low-kg", "unknown", "u:2026-09-19"]);
  });
});

describe("data-integrity audit contract", () => {
  const rows: Finding[] = [{ name: "targets_consistency", count: 1, severity: "high",
    sampleIds: [settings.user_id], fixPath: "owner step" }];

  it("refuses production fixes and a branch pointed at production", () => {
    process.env.SUPABASE_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(() => parseArgs(["--production", "--fix"])).toThrow(/forbidden/);
    expect(() => parseArgs(["--production", "--fix", "--read-only"])).toThrow(/forbidden/);
    expect(() => parseArgs(["--branch", "--fix"])).toThrow(/refuses production/);
  });

  it("allows production and branch read-only sweeps but requires --branch for fixes", () => {
    process.env.SUPABASE_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
    expect(parseArgs(["--production", "--read-only", "--twice"]))
      .toMatchObject({ environment: "production", fix: false, twice: true });
    process.env.SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    expect(parseArgs(["--branch", "--read-only"]))
      .toMatchObject({ environment: "branch", fix: false });
    expect(() => parseArgs(["--fix"])).toThrow(/choose --production or --branch/);
  });

  it("lets a clean production read-only sweep exit successfully", () => {
    process.env.SUPABASE_URL = "https://fivatgdpuenszxxnijpc.supabase.co";
    const options = parseArgs(["--production", "--read-only"]);
    expect(options.fix).toBe(false);
    expect(exitCode([{ ...rows[0], count: 0 }], options.accepted)).toBe(0);
  });

  it("requires an explicit accepted owner step for every nonzero finding", () => {
    expect(exitCode(rows, new Set())).toBe(1);
    expect(exitCode(rows, new Set(["targets_consistency"]))).toBe(0);
    expect(exitCode([{ ...rows[0], name: "health_ranges", severity: "low" }], new Set())).toBe(1);
    expect(exitCode([{ ...rows[0], name: "prefs_orphans", severity: "medium" }], new Set())).toBe(1);
  });

  it("never fails the exit code for informational findings", () => {
    expect(exitCode([{
      ...rows[0], name: "food_refs_unused", severity: "info", count: 147,
    }], new Set())).toBe(0);
  });

  it("stamps the report path and header from the run clock instead of a fixed date", () => {
    const sep19 = () => new Date("2026-09-19T12:00:00.000Z").getTime();
    const oct03 = () => new Date("2026-10-03T06:00:00.000Z").getTime();
    expect(reportDate(sep19)).toBe("2026-09-19");
    expect(reportPath(reportDate(sep19))).toBe("docs/audit/2026-09-19-data-integrity.md");
    expect(reportDate(oct03)).toBe("2026-10-03");
    expect(reportPath(reportDate(oct03))).toBe("docs/audit/2026-10-03-data-integrity.md");
    // A later run's own report never collides with an earlier day's path.
    expect(reportPath(reportDate(sep19))).not.toBe(reportPath(reportDate(oct03)));
  });

  it("takes one date for both the header and the path, so a run straddling UTC midnight cannot mismatch", () => {
    // A single call site computes `reportDate()` once and feeds that same string to
    // `reportPath()`; a run whose Date.now() ticks past UTC midnight between two separate
    // reportDate() calls could otherwise write a header for one day into the other day's file.
    const date = reportDate(() => new Date("2026-10-03T23:59:59.900Z").getTime());
    expect(reportPath(date)).toBe(`docs/audit/${date}-data-integrity.md`);
  });

  it("omits sample identifiers from the production artifact", () => {
    const output = markdown(rows, new Set(), true);
    expect(output).not.toContain(settings.user_id);
    expect(output).toContain("withheld (production counts only)");
  });

  it("produces a stable checksum for identical serialized finding tables", () => {
    const first = markdown(rows, new Set(), true);
    const second = markdown(structuredClone(rows), new Set(), true);
    expect(reportChecksum(first)).toBe(reportChecksum(second));
    expect(reportChecksum(first)).not.toBe(reportChecksum(markdown([
      { ...rows[0], count: 2 },
    ], new Set(), true)));
  });

  it("reads RLS metadata from the selected project through the Management API", async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify([
      { tablename: "user_food_prefs", relrowsecurity: true },
    ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    const disabled = await rlsDisabledIds("fivatgdpuenszxxnijpc", "token", request);
    expect(request).toHaveBeenCalledWith(
      "https://api.supabase.com/v1/projects/fivatgdpuenszxxnijpc/database/query",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.query).toContain("pg_catalog.pg_class");
    expect(disabled).toContain("target_profiles");
    expect(disabled).not.toContain("user_food_prefs");
  });
});
