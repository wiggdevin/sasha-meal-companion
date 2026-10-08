// Onboarding v2 G1-G3 on the server's own recompute: a Settings edit, a coach `update_profile`
// or an older phone can never leave a held account (pregnancy, breastfeeding, an eating disorder,
// kidney disease, a clinician-set diet) on a loss or gain pace, and an account under 18 gets no
// derived revision at all.
import { describe, expect, it } from "vitest";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";
import { SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";
import { TODAY, USER, fakeClient, settingsRow, staleTarget, type Row } from "./recompute-fake";

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
