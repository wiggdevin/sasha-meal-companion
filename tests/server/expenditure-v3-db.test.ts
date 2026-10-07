// TDEE step E (exp-3.0.0): the estimate row stores and returns the v3 fields, and the nightly run
// reads the frozen seed, the day marks and the first-mark date from a real database.  [needs branch]
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, HAS_BRANCH, userClient, type TestUser } from "../helpers/supabase";
import { latestEstimate, runEstimate } from "@/lib/server/expenditure";
import { ENGINE_VERSION } from "@/lib/expenditure";

const run = HAS_BRANCH ? describe : describe.skip;

run("expenditure exp-3.0.0 on a real database", () => {
  let user: TestUser; let client: SupabaseClient; let admin: SupabaseClient;

  beforeAll(async () => {
    admin = adminClient();
    const email = `exp-v3-${crypto.randomUUID()}@meal-companion.test`;
    const password = `Local-${crypto.randomUUID()}-1`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("Test user failed");
    user = { id: created.data.user.id, email, password };
    client = await userClient(user);
    const settings = await admin.from("user_settings").upsert({ user_id: user.id,
      first_opened_at: "2026-09-01T00:00:00Z", sex: "female", birth_year: 1968, height_cm: 170,
      weight_kg: 72.6, activity_level: "moderate" });
    expect(settings.error).toBeNull();
  });

  afterAll(async () => {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  });

  it("stores a starting row with its range and seed source, and the account reads it back", async () => {
    const result = await runEstimate(admin, user.id, "2026-10-10", { weighIns: async () => [] });
    expect(result).toMatchObject({ status: "burn_in", phase: "starting", tdeeKcal: null,
      seedSource: "live_profile", proposalEligible: false, engineVersion: ENGINE_VERSION });
    // Persona seed 1,873 (Mifflin 1,337.5 × 1.40): 1,873 ± 281 → 1,590–2,150.
    expect([result.tdeeLowKcal, result.tdeeHighKcal]).toEqual([1590, 2150]);
    const read = await latestEstimate(client, user.id);
    expect(read).toMatchObject({ phase: "starting", tdeeLowKcal: 1590, tdeeHighKcal: 2150,
      dataWeight: 0, seedSource: "live_profile", proposalEligible: false, reviewFlag: null,
      profileTdeeKcal: 1873 });
  });

  it("reads the first-mark date and the day marks without failing", async () => {
    const marked = await client.rpc("apply_sync_op", { p_user_id: user.id, p_op: {
      op_id: crypto.randomUUID(), entity: "plan_days", entity_id: "2026-10-05", kind: "create",
      base_rev: null, payload: { local_date: "2026-10-05", day_complete_at: "2026-10-05T21:00:00Z" },
      client_ts: new Date().toISOString() } });
    expect(marked.error).toBeNull();
    const result = await runEstimate(admin, user.id, "2026-10-11", { weighIns: async () => [] });
    expect(result.phase).toBe("starting");
    const stored = await admin.from("expenditure_estimates")
      .select("phase, seed_source, proposal_eligible").eq("user_id", user.id)
      .eq("local_date", "2026-10-11").single();
    expect(stored.data).toEqual({ phase: "starting", seed_source: "live_profile",
      proposal_eligible: false });
  });
});
