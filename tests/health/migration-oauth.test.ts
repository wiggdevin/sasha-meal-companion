/** [needs branch] */
import { describe, expect, it } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("20260926000000_phase5_oura_oauth", () => {
  it("locks one job run per (job, user, run_key)", async () => {
    const { a } = await createTestUsers();
    const admin = adminClient();
    const row = { job: "oura-pull", user_id: a.userId, run_key: "2026-09-15", status: "running" };
    await admin.from("job_runs").delete().match({ job: row.job, user_id: row.user_id, run_key: row.run_key });
    expect((await admin.from("job_runs").insert(row)).error).toBeNull();
    expect((await admin.from("job_runs").insert(row)).error?.code).toBe("23505");
  });

  it("refuses a provider other than oura", async () => {
    const { a } = await createTestUsers();
    const { error } = await adminClient().from("oauth_states").insert({
      state_hash: "\\x00", provider: "strava", user_id: a.userId,
      expires_at: "2026-09-15T14:10:00Z" });
    expect(error?.message).toMatch(/oauth_states_provider_check/);
  });

  it("keeps user B out of user A's job_runs", async () => {
    const { a, b } = await createTestUsers();
    await adminClient().from("job_runs").upsert({ job: "oura-pull", user_id: a.userId,
      run_key: "2026-09-16", status: "ok" });
    const { data } = await b.client.from("job_runs").select("run_key").eq("user_id", a.userId);
    expect(data).toEqual([]);
  });
});
