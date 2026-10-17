// Onboarding v2 G1-G3 on the server's own recompute: a Settings edit, a coach `update_profile`
// or an older phone can never leave a held account (pregnancy, breastfeeding, an eating disorder,
// kidney disease, a clinician-set diet) on a loss or gain pace, and an account under 18 gets no
// derived revision at all.
import { describe, expect, it, vi } from "vitest";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";
import { SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";
import { TODAY, USER, fakeClient, settingsRow, staleTarget, type Row } from "./recompute-fake";

vi.mock("@/lib/server/admin", async () => (await import("@/tests/helpers/admin-fake")).adminModule);

const LOSING = { goal: "lose_fat", goal_rate_bp_week: -50 };
const conditions = (...items: string[]) => ({ constraint_profiles: [{ user_id: USER, conditions: items }] });

describe("recomputeDerivedTarget pace holds", () => {
  it("keeps the stored loss pace when nothing holds it", async () => {
    const fake = fakeClient(settingsRow(LOSING), [staleTarget()]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes.at(-1)).toMatchObject({ goal_rate_bp_week: -50, input_goal: "lose_fat" });
  });

  it("derives a held account at a 0 pace and stays settled", async () => {
    const fake = fakeClient(settingsRow(LOSING), [staleTarget()], [],
      conditions(SAFETY_CONDITION_TEXT.breastfeeding));
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    expect(fake.writes.at(-1)).toMatchObject({ goal_rate_bp_week: 0, input_goal: "lose_fat" });
    // The goal is kept; the plan holds maintenance until the hold is removed.
    const again = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(again.status).toBe("unchanged");
  });

  it("restores the stored preset once the hold is removed", async () => {
    const tables: Record<string, Row[]> = conditions(SAFETY_CONDITION_TEXT.clinicianDiet);
    const fake = fakeClient(settingsRow(LOSING), [staleTarget()], [], tables);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes.at(-1)).toMatchObject({ goal_rate_bp_week: 0 });
    tables.constraint_profiles = [{ user_id: USER, conditions: [] }];
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes.at(-1)).toMatchObject({ goal_rate_bp_week: -50 });
  });

  it("skips an account under 18 and writes nothing", async () => {
    const fake = fakeClient(settingsRow({ ...LOSING, birth_year: 2010 }), [staleTarget()]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "adult_only" });
    expect(fake.writes).toHaveLength(0);
  });

  it("reads a hold from a stored dietary profile too", async () => {
    const fake = fakeClient(settingsRow(LOSING), [staleTarget()], [],
      { user_dietary_profiles: [{ user_id: USER, profile_id: "ckd", source: "user_stated" }] });
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    const write = fake.writes.at(-1) as Row & { training_macros: Row };
    expect(write.goal_rate_bp_week).toBe(0);
    // Kidney disease: standard protein, 0.8 g/kg of 72.575 kg.
    expect(write.training_macros.protein).toBe(58);
  });
});

// W007 (audit 2026-10-10 A094): a new under-18 signal supersedes the paced revisions it finds.
describe("recomputeDerivedTarget under 18 with a pace in force", () => {
  it("supersedes today's paced revision at a 0 pace and then settles", async () => {
    const fake = fakeClient(settingsRow({ ...LOSING, birth_year: 2010 }),
      [staleTarget({ goal_rate_bp_week: -50, input_goal: "lose_fat" })]);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({ effective_from: TODAY, goal_rate_bp_week: 0,
      input_goal: "lose_fat" });
    // Nothing paced is left, so a second run builds nothing more for the minor.
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "adult_only" });
    expect(fake.writes).toHaveLength(1);
  });

  it("supersedes a paced revision when the minor profile is added, scheduled ones included", async () => {
    const fake = fakeClient(settingsRow(LOSING), [
      staleTarget({ goal_rate_bp_week: -50, input_goal: "lose_fat" }),
      staleTarget({ id: "f1", rev: 6, effective_from: "2026-10-12", formula_name: "proposal-v1",
        target_source: "proposal", goal_rate_bp_week: -50, input_goal: "lose_fat" }),
    ], [], { user_dietary_profiles: [{ user_id: USER, profile_id: "minor_under_18",
      source: "user_stated" }] });
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes.map((w) => [w.effective_from, w.goal_rate_bp_week]))
      .toEqual([[TODAY, 0], ["2026-10-12", 0]]);
  });
});

// W007 (audit 2026-10-10 A003): kidney disease takes standard protein on adaptive and proposal
// revisions too, not only on paced ones.
describe("recomputeDerivedTarget with kidney disease on a 0-pace adaptive revision", () => {
  const ckd = { user_dietary_profiles: [{ user_id: USER, profile_id: "ckd", source: "user_stated" }] };
  const adaptive = (over: Parameters<typeof staleTarget>[0] = {}) => staleTarget({
    formula_name: "adaptive-expenditure-v1", target_source: "proposal", goal_rate_bp_week: 0,
    ...over });

  it("leaves the adaptive revision alone without a kidney hold", async () => {
    const fake = fakeClient(settingsRow(), [adaptive()]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
    expect(fake.writes).toHaveLength(0);
  });

  it("switches the revision in force and a scheduled one to 0.8 g/kg", async () => {
    const fake = fakeClient(settingsRow(), [adaptive(),
      adaptive({ id: "f1", rev: 6, effective_from: "2026-10-12" })], [], ckd);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    const writes = fake.writes as (Row & { training_macros: Row; rest_macros: Row })[];
    expect(writes.map((w) => w.effective_from)).toEqual([TODAY, "2026-10-12"]);
    for (const write of writes) {
      expect(write.training_macros.protein).toBe(58);
      expect(write.rest_macros.protein).toBe(58);
      expect(write.protein_g_min).toBe(58);
    }
    // Settled: a second run finds nothing above standard protein.
    const count = fake.writes.length;
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes).toHaveLength(count);
  });
});

// W007 review: a manual protein pin is not a way around kidney disease's standard protein.
describe("recomputeDerivedTarget with kidney disease and a protein pin", () => {
  const ckd = { user_dietary_profiles: [{ user_id: USER, profile_id: "ckd", source: "user_stated" }] };
  const pinned = (over: Parameters<typeof staleTarget>[0] = {}) => staleTarget({
    target_source: "manual", pin_protein_g: 145, ...over });

  for (const [label, target] of [
    ["a derived manual revision", pinned()],
    ["an adaptive revision", pinned({ formula_name: "adaptive-expenditure-v1",
      target_source: "proposal" })],
  ] as const) {
    it(`caps ${label} pinned at 145 g to 0.8 g/kg and keeps the pin`, async () => {
      const fake = fakeClient(settingsRow({ protein_g: 145 }), [target], [], ckd);
      const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
      expect(outcome.status).toBe("written");
      const write = fake.writes.at(-1) as Row & { training_macros: Row; rest_macros: Row };
      expect(write.training_macros.protein).toBe(58);
      expect(write.rest_macros.protein).toBe(58);
      expect(write.protein_g_min).toBe(58);
      // The pin is the user's own and comes back when the hold is removed.
      expect(write.pin_protein_g).toBe(145);
      const count = fake.writes.length;
      await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
      expect(fake.writes).toHaveLength(count);
    });
  }

  it("applies the 145 g pin again without the hold", async () => {
    const fake = fakeClient(settingsRow({ protein_g: 145 }), [pinned()]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    const write = fake.writes.at(-1) as Row & { training_macros: Row };
    expect(write.training_macros.protein).toBe(145);
  });
});

// W007 review: a held or under-18 account whose profile can no longer derive still loses its pace.
describe("recomputeDerivedTarget supersede with an incomplete profile", () => {
  const paced = (over: Parameters<typeof staleTarget>[0] = {}) =>
    staleTarget({ goal_rate_bp_week: -50, input_goal: "lose_fat", ...over });

  for (const [label, over, tables] of [
    ["under 18", { birth_year: 2010 }, {}],
    ["breastfeeding", {}, conditions(SAFETY_CONDITION_TEXT.breastfeeding)],
  ] as const) {
    it(`copies the paced revision at a 0 pace (${label}) and then settles`, async () => {
      const target = paced();
      const fake = fakeClient(settingsRow({ ...LOSING, ...over, height_cm: null }),
        [target, paced({ id: "f1", rev: 6, effective_from: "2026-10-12",
          formula_name: "proposal-v1", target_source: "proposal" })], [], { ...tables });
      const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
      expect(outcome.status).toBe("written");
      expect(fake.writes.map((w) => [w.effective_from, w.goal_rate_bp_week]))
        .toEqual([[TODAY, 0], ["2026-10-12", 0]]);
      // The macros are the revision's own: only the pace ends.
      expect(fake.writes[0]).toMatchObject({ training_macros: target.training_macros,
        rest_macros: target.rest_macros, input_goal: "lose_fat" });
      const count = fake.writes.length;
      await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
      expect(fake.writes).toHaveLength(count);
    });
  }
});
