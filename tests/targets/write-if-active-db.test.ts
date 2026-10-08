// write_target_revision_if_active against the real database: the server recompute's conditional
// write lands only while the revision it planned from is still active.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { recomputeDerivedTarget } from "@/lib/server/target-recompute";

const run = HAS_BRANCH ? describe : describe.skip;

function row(day: string, kcal: number): Record<string, unknown> {
  return {
    effective_from: day, target_source: "derived", formula_name: "profile-energy-v1",
    training_macros: { kcal, protein: 145, carbs: Math.round((kcal - 145 * 4 - 52 * 9) / 4), fat: 52 },
    rest_macros: { kcal: kcal - 196, protein: 145, carbs: Math.round((kcal - 196 - 145 * 4 - 52 * 9) / 4), fat: 52 },
    pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
    input_weight_kg: 72.575, input_weight_source: "onboarding", input_training_weekdays: [1, 3, 4, 5],
    input_activity_level: "moderate", input_goal: "recomp", goal_rate_bp_week: 0,
    kcal_min: 1430, kcal_min_source: "macro_minimum",
  };
}

run("write_target_revision_if_active", () => {
  let client: SupabaseClient;
  let admin: SupabaseClient;
  let userId = "";

  beforeAll(async () => {
    const users = await createTestUsers();
    client = users.a.client;
    admin = users.admin;
    userId = users.a.userId;
    await resetUser(userId);
  });
  afterAll(async () => { if (userId) await resetUser(userId); });

  it("writes when nothing is active and null was expected, then refuses a stale expectation", async () => {
    const first = await admin.rpc("write_target_revision_if_active",
      { p_user_id: userId, p_row: row("2026-09-22", 2104), p_expected_id: null });
    expect(first.error).toBeNull();
    const firstId = (first.data as { id: string }).id;
    expect(firstId).toBeTruthy();

    // A second writer still expecting "nothing active" is refused and writes nothing.
    const stale = await admin.rpc("write_target_revision_if_active",
      { p_user_id: userId, p_row: row("2026-10-03", 1960), p_expected_id: null });
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual({ conflict: true, active_id: firstId });

    const current = await admin.rpc("write_target_revision_if_active",
      { p_user_id: userId, p_row: row("2026-10-03", 1960), p_expected_id: firstId });
    expect(current.error).toBeNull();
    expect(current.data).toMatchObject({ kcal_train: 1960, effective_from: "2026-10-03" });

    const { data: rows } = await client.from("target_profiles").select("kcal_train")
      .eq("user_id", userId).order("rev");
    expect((rows ?? []).map((r) => r.kcal_train)).toEqual([2104, 1960]);
  });

  it("recompute end to end: replaces a stale derived revision, then is a no-op", async () => {
    await resetUser(userId);
    const settings = await admin.from("user_settings").upsert({
      user_id: userId, first_opened_at: "2026-09-20T17:00:00Z", onboarded_at: "2026-09-22T11:12:00Z",
      time_zone: "America/Denver", height_cm: 170.2, birth_year: 1968, sex: "female",
      body_fat_pct: 32, weight_kg: 72.575, activity_level: "moderate", goal: "recomp",
      training_weekdays: [1, 3, 4, 5],
    });
    expect(settings.error).toBeNull();
    const stale = await admin.rpc("write_target_revision", { p_user_id: userId,
      p_row: { ...row("2026-09-22", 2104), kcal_min: 1200, kcal_min_source: "legacy_default" } });
    expect(stale.error).toBeNull();

    // The settings-rev fence: the active id matches, the settings rev does not → no write.
    const { data: settingsRow } = await client.from("user_settings").select("rev")
      .eq("user_id", userId).single();
    const staleId = (stale.data as { id: string }).id;
    const fenced = await admin.rpc("write_target_revision_if_active", { p_user_id: userId,
      p_row: row("2026-10-03", 1960), p_expected_id: staleId,
      p_expected_settings_rev: Number(settingsRow?.rev ?? 0) + 1 });
    expect(fenced.error).toBeNull();
    expect(fenced.data).toMatchObject({ conflict: true, active_id: staleId });
    const { count } = await client.from("target_profiles").select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    expect(count).toBe(1);

    const outcome = await recomputeDerivedTarget(client, userId, { today: "2026-10-03" });
    expect(outcome.status).toBe("written");
    expect(outcome.active).toMatchObject({ kcal_train: 1960, kcal_rest: 1764, kcal_min: 1430,
      effective_from: "2026-10-03", formula_name: "profile-energy-v1" });
    await expect(recomputeDerivedTarget(client, userId, { today: "2026-10-03" }))
      .resolves.toMatchObject({ status: "unchanged" });
  });

  it("recompute end to end: keeps a manual pin and skips an adaptive revision", async () => {
    await resetUser(userId);
    await admin.from("user_settings").upsert({
      user_id: userId, first_opened_at: "2026-09-20T17:00:00Z", onboarded_at: "2026-09-22T11:12:00Z",
      time_zone: "America/Denver", height_cm: 170.2, birth_year: 1968, sex: "female",
      body_fat_pct: 32, weight_kg: 72.575, activity_level: "light", goal: "recomp",
      training_weekdays: [1, 3, 4, 5],
    });
    await admin.rpc("write_target_revision", { p_user_id: userId,
      p_row: { ...row("2026-09-22", 2104), target_source: "manual", pin_training_kcal: 2104 } });
    const pinned = await recomputeDerivedTarget(client, userId, { today: "2026-10-03" });
    expect(pinned.status).toBe("written");
    expect(pinned.active).toMatchObject({ target_source: "manual", pin_training_kcal: 2104,
      input_activity_level: "light" });
    await expect(recomputeDerivedTarget(client, userId, { today: "2026-10-03" }))
      .resolves.toMatchObject({ status: "unchanged" });

    await admin.rpc("write_target_revision", { p_user_id: userId,
      p_row: { ...row("2026-10-03", 2000), formula_name: "adaptive-tdee-v1" } });
    await expect(recomputeDerivedTarget(client, userId, { today: "2026-10-03" }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
  });
});
