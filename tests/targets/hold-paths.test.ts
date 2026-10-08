// Onboarding v2 G1-G3, the paths a first review missed: a restore (Undo), a proposal approval and
// a later hold on an adaptive revision can never bring back a pace for a held account or a plan
// for an account under 18.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { restoreTargetRevision, writeTargetRevisionSet } from "@/lib/server/targets";
import { decideProposal } from "@/lib/server/proposals";
import { recomputeDerivedTarget, settingsFromRow } from "@/lib/server/target-recompute";
import { AdultOnlyError, SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";
import { TODAY, USER, activeOn, fakeClient, settingsRow, staleTarget } from "./recompute-fake";

import { adminFake } from "@/tests/helpers/admin-fake";

vi.mock("@/lib/server/admin", async () => (await import("@/tests/helpers/admin-fake")).adminModule);

type Row = Record<string, unknown>;

/** Every chain method returns the chain; `maybeSingle` is the first matching row, `then` all. */
function client(tables: Record<string, Row[]>,
  rpc: ReturnType<typeof vi.fn> = vi.fn(async () => ({ data: null, error: null }))) {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const chain: Record<string, unknown> = {
      select: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return chain; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    return chain;
  };
  const fake = { from, rpc } as unknown as SupabaseClient;
  adminFake.client = fake;
  return { client: fake, rpc };
}

const prior = staleTarget({ id: "t2", goal_rate_bp_week: -50, input_goal: "lose_fat",
  kcal_min_source: "macro_minimum" });
const held = { constraint_profiles: [{ user_id: USER, conditions: [SAFETY_CONDITION_TEXT.pregnant] }] };

describe("restore", () => {
  it("refuses to restore a pace a hold now keeps at maintenance, and any plan for a minor", async () => {
    const { client: c, rpc } = client({ target_profiles: [prior], ...held,
      user_settings: [{ user_id: USER, birth_year: 1990 }] });
    await expect(restoreTargetRevision(c, USER, "t2", TODAY))
      .rejects.toMatchObject({ status: 409, code: "rate_not_eligible" });
    const { client: minor } = client({ target_profiles: [prior],
      user_settings: [{ user_id: USER, birth_year: 2011 }] });
    await expect(restoreTargetRevision(minor, USER, "t2", TODAY)).rejects.toBeInstanceOf(AdultOnlyError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("proposal approval", () => {
  const approve = (c: SupabaseClient) => decideProposal(c, USER, "p1",
    { decision: "approve", expectedStatus: "pending" } as never);

  it("approves for an account with no hold", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "approved", target_profile_id: "t9" }, error: null }));
    const { client: c } = client({ target_profiles: [prior],
      user_settings: [{ user_id: USER, birth_year: 1990, time_zone: "America/Denver" }] }, rpc);
    await expect(approve(c)).resolves.toMatchObject({ status: "approved" });
  });

  it("refuses while a held account's revision still carries a pace, and always for a minor", async () => {
    const rpc = vi.fn();
    const { client: c } = client({ target_profiles: [prior], ...held,
      user_settings: [{ user_id: USER, birth_year: 1990, time_zone: "America/Denver" }] }, rpc);
    await expect(approve(c)).rejects.toMatchObject({ status: 409, code: "rate_not_eligible" });
    const { client: minor } = client({ target_profiles: [{ ...prior, goal_rate_bp_week: 0 }],
      user_settings: [{ user_id: USER, birth_year: 2012, time_zone: "America/Denver" }] }, rpc);
    await expect(approve(minor)).rejects.toBeInstanceOf(AdultOnlyError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("a hold on an adaptive revision", () => {
  it("re-derives a held account from its profile at a 0 pace instead of leaving the deficit", async () => {
    const adaptive = staleTarget({ formula_name: "adaptive-tdee-v1", goal_rate_bp_week: -50,
      input_goal: "lose_fat" });
    const free = fakeClient(settingsRow({ goal: "lose_fat", goal_rate_bp_week: -50 }), [adaptive]);
    await expect(recomputeDerivedTarget(free.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
    const fake = fakeClient(settingsRow({ goal: "lose_fat", goal_rate_bp_week: -50 }),
      [staleTarget({ formula_name: "adaptive-tdee-v1", goal_rate_bp_week: -50, input_goal: "lose_fat" })],
      [], held);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    expect(fake.writes.at(-1)).toMatchObject({ goal_rate_bp_week: 0, formula_name: "profile-energy-v1" });
  });
});

describe("a direct derive request", () => {
  // The request body says 1990; the account's stored birth year says 15 on the revision's date.
  const adultBody = settingsFromRow(settingsRow({ birth_year: 1990, goal: "maintain" }));
  const derive = (today = TODAY) => ({ operation: "derive" as const, input: {
    settings: adultBody, latestWeighInKg: null, today, trainingWeekdays: [1, 3] } });

  it("never lifts the stored under-18 birth year with an adult one from the body", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const { client: c } = client({ user_settings: [{ user_id: USER, birth_year: 2011 }] }, rpc);
    await expect(writeTargetRevisionSet(c, USER, derive())).rejects.toBeInstanceOf(AdultOnlyError);
    await expect(writeTargetRevisionSet(c, USER, derive(), derive("2026-09-01")))
      .rejects.toBeInstanceOf(AdultOnlyError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("a hold with a revision scheduled after today", () => {
  const paced = { goal: "lose_fat", goal_rate_bp_week: -50 };
  const dates = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-12", "2027-01-01"];

  it("neutralises today's adaptive pace and every scheduled pace, on their own dates", async () => {
    const fake = fakeClient(settingsRow(paced), [
      staleTarget({ formula_name: "adaptive-tdee-v1", goal_rate_bp_week: -50, input_goal: "lose_fat" }),
      staleTarget({ id: "f1", rev: 6, effective_from: "2026-10-05", formula_name: "proposal-v1",
        goal_rate_bp_week: -50, input_goal: "lose_fat", input_weight_source: "weigh-in",
        input_weight_kg: 70 }),
    ], [], held);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    expect(fake.writes.map((w) => [w.effective_from, w.goal_rate_bp_week]))
      .toEqual([[TODAY, 0], ["2026-10-05", 0]]);
    expect(fake.writes[1]).toMatchObject({ input_weight_kg: 70, input_weight_source: "weigh-in" });
    for (const date of dates) expect(activeOn(fake.targets, date)?.goal_rate_bp_week).toBe(0);
  });

  it("neutralises a scheduled pace even when today's revision has none", async () => {
    const fake = fakeClient(settingsRow(paced), [
      staleTarget(),
      staleTarget({ id: "f1", rev: 6, effective_from: "2026-10-12", goal_rate_bp_week: -50,
        input_goal: "lose_fat" }),
    ], [], held);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    for (const date of dates) expect(activeOn(fake.targets, date)?.goal_rate_bp_week).toBe(0);
  });

  it("still leaves a scheduled revision alone when the account has no hold", async () => {
    const fake = fakeClient(settingsRow(paced), [staleTarget(),
      staleTarget({ id: "f1", rev: 6, effective_from: "2026-10-12", goal_rate_bp_week: -50 })]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "future_revision" });
    expect(fake.writes).toEqual([]);
  });
});
